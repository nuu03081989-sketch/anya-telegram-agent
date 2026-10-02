import { constants, sign } from "node:crypto";
import { connect } from "node:http2";

const IAM_TOKEN_URL = "https://iam.api.cloud.yandex.net/iam/v1/tokens";
const BILLING_API_URL = "https://billing.api.cloud.yandex.net";
const BILLING_GRPC_ORIGIN = "https://billing.api.cloud.yandex.net";
const BILLING_SERVICE_USAGE_PATH =
  "/yandex.cloud.billing.usage_records.v1.ConsumptionCoreService/GetServiceUsageReport";
const BILLING_CACHE_MS = 70 * 1000;

type AuthorizedKeyFile = {
  id?: string;
  service_account_id?: string;
  private_key?: string;
};

type IamTokenCache = {
  token: string;
  expiresAtMs: number;
};

export type YandexBillingServiceExpense = {
  name: string;
  cost: number;
  expense: number;
};

export type YandexBillingSummary = {
  billingAccountId: string;
  billingAccountName: string;
  currency: string;
  cost: number;
  expense: number;
  monthKey: string;
  services: YandexBillingServiceExpense[];
  fetchedAt: string;
};

let iamTokenCache: IamTokenCache | null = null;
let billingCache:
  | {
      expiresAtMs: number;
      value: YandexBillingSummary;
    }
  | null = null;

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function readAuthorizedKey(): Required<AuthorizedKeyFile> {
  const raw = process.env.YANDEX_SERVICE_ACCOUNT_KEY_JSON;
  if (!raw) {
    throw new Error("YANDEX_SERVICE_ACCOUNT_KEY_JSON is missing");
  }

  let parsed: AuthorizedKeyFile;
  try {
    parsed = JSON.parse(raw) as AuthorizedKeyFile;
  } catch {
    throw new Error("YANDEX_SERVICE_ACCOUNT_KEY_JSON is not valid JSON");
  }

  const id = String(parsed.id || "").trim();
  const serviceAccountId = String(parsed.service_account_id || "").trim();
  let privateKey = String(parsed.private_key || "");

  const pemStart = privateKey.indexOf("-----BEGIN PRIVATE KEY-----");
  if (pemStart >= 0) {
    privateKey = privateKey.slice(pemStart);
  }

  if (!id || !serviceAccountId || !privateKey.includes("PRIVATE KEY")) {
    throw new Error("YANDEX_SERVICE_ACCOUNT_KEY_JSON has incomplete key data");
  }

  return {
    id,
    service_account_id: serviceAccountId,
    private_key: privateKey,
  };
}

function createServiceAccountJwt() {
  const key = readAuthorizedKey();
  const now = Math.floor(Date.now() / 1000);

  const header = base64UrlJson({
    typ: "JWT",
    alg: "PS256",
    kid: key.id,
  });
  const payload = base64UrlJson({
    iss: key.service_account_id,
    aud: IAM_TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });

  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: key.private_key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64url");

  return `${signingInput}.${signature}`;
}

async function getIamToken() {
  if (
    iamTokenCache &&
    iamTokenCache.expiresAtMs - Date.now() > 5 * 60 * 1000
  ) {
    return iamTokenCache.token;
  }

  const jwt = createServiceAccountJwt();
  const response = await fetch(IAM_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jwt }),
  });

  const data = (await response.json().catch(() => ({}))) as {
    iamToken?: string;
    expiresAt?: string;
    message?: string;
  };

  if (!response.ok || !data.iamToken) {
    throw new Error(
      `Yandex IAM token request failed: ${response.status} ${data.message || ""}`.trim()
    );
  }

  const expiresAtMs = data.expiresAt
    ? new Date(data.expiresAt).getTime()
    : Date.now() + 60 * 60 * 1000;

  iamTokenCache = {
    token: data.iamToken,
    expiresAtMs: Number.isFinite(expiresAtMs)
      ? expiresAtMs
      : Date.now() + 60 * 60 * 1000,
  };

  return data.iamToken;
}

async function getBillingAccount(iamToken: string) {
  const response = await fetch(
    `${BILLING_API_URL}/billing/v1/billingAccounts?pageSize=100`,
    {
      headers: {
        Authorization: `Bearer ${iamToken}`,
      },
    }
  );

  const data = (await response.json().catch(() => ({}))) as {
    billingAccounts?: Array<{
      id?: string;
      name?: string;
      active?: boolean;
      currency?: string;
    }>;
    message?: string;
  };

  if (!response.ok) {
    throw new Error(
      `Yandex Billing account list failed: ${response.status} ${data.message || ""}`.trim()
    );
  }

  const accounts = (data.billingAccounts || []).filter(
    (account) => account.id && account.active !== false
  );

  if (accounts.length === 0) {
    throw new Error("No active Yandex Billing account is available");
  }

  if (accounts.length > 1) {
    throw new Error(
      "More than one active Yandex Billing account is available; explicit account selection is required"
    );
  }

  return {
    id: String(accounts[0].id),
    name: String(accounts[0].name || "Yandex Cloud"),
    currency: String(accounts[0].currency || "RUB"),
  };
}

function encodeVarint(input: number | bigint) {
  let value = typeof input === "bigint" ? input : BigInt(Math.max(0, Math.floor(input)));
  const bytes: number[] = [];

  while (value >= 0x80n) {
    bytes.push(Number((value & 0x7fn) | 0x80n));
    value >>= 7n;
  }

  bytes.push(Number(value));
  return Buffer.from(bytes);
}

function encodeLengthDelimited(fieldNumber: number, value: Buffer) {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  return Buffer.concat([tag, encodeVarint(value.length), value]);
}

function encodeString(fieldNumber: number, value: string) {
  return encodeLengthDelimited(fieldNumber, Buffer.from(value, "utf8"));
}

function encodeTimestamp(date: Date) {
  const seconds = BigInt(Math.floor(date.getTime() / 1000));
  const field = Buffer.concat([encodeVarint(1 << 3), encodeVarint(seconds)]);
  return field;
}

function krasnoyarskDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Krasnoyarsk",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = Number(parts.find((part) => part.type === "year")?.value || "0");
  const month = Number(parts.find((part) => part.type === "month")?.value || "0");
  const day = Number(parts.find((part) => part.type === "day")?.value || "0");

  return { year, month, day };
}

function currentBillingPeriod(date = new Date()) {
  const { year, month, day } = krasnoyarskDateParts(date);
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const dayKey = `${monthKey}-${String(day).padStart(2, "0")}`;

  return {
    monthKey,
    start: new Date(`${monthKey}-01T00:00:00Z`),
    end: new Date(`${dayKey}T23:59:59Z`),
  };
}

function encodeUsageReportRequest(
  billingAccountId: string,
  startDate: Date,
  endDate: Date
) {
  return Buffer.concat([
    encodeString(1, billingAccountId),
    encodeLengthDelimited(2, encodeTimestamp(startDate)),
    encodeLengthDelimited(3, encodeTimestamp(endDate)),
  ]);
}

type ProtoField =
  | { field: number; wire: 0; value: bigint }
  | { field: number; wire: 2; value: Buffer };

function readVarint(buffer: Buffer, start: number) {
  let offset = start;
  let shift = 0n;
  let value = 0n;

  while (offset < buffer.length) {
    const byte = buffer[offset];
    value |= BigInt(byte & 0x7f) << shift;
    offset += 1;

    if ((byte & 0x80) === 0) {
      return { value, offset };
    }

    shift += 7n;
    if (shift > 70n) throw new Error("Invalid protobuf varint");
  }

  throw new Error("Unexpected end of protobuf varint");
}

function decodeFields(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;

    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);

    if (wire === 0) {
      const value = readVarint(buffer, offset);
      offset = value.offset;
      fields.push({ field, wire: 0, value: value.value });
      continue;
    }

    if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const size = Number(length.value);
      const end = offset + size;
      if (end > buffer.length) throw new Error("Invalid protobuf length");
      fields.push({ field, wire: 2, value: buffer.subarray(offset, end) });
      offset = end;
      continue;
    }

    if (wire === 1) {
      offset += 8;
      continue;
    }

    if (wire === 5) {
      offset += 4;
      continue;
    }

    throw new Error(`Unsupported protobuf wire type: ${wire}`);
  }

  return fields;
}

function stringField(buffer: Buffer, fieldNumber: number) {
  const field = decodeFields(buffer).find(
    (item) => item.field === fieldNumber && item.wire === 2
  );
  return field && field.wire === 2 ? field.value.toString("utf8") : "";
}

function decimalMessage(buffer: Buffer) {
  const value = stringField(buffer, 1);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseServiceEntity(buffer: Buffer): YandexBillingServiceExpense | null {
  const fields = decodeFields(buffer);
  const costField = fields.find((item) => item.field === 1 && item.wire === 2);
  const expenseField = fields.find((item) => item.field === 3 && item.wire === 2);
  const serviceField = fields.find((item) => item.field === 4 && item.wire === 2);

  if (!serviceField || serviceField.wire !== 2) return null;

  const name = stringField(serviceField.value, 2) || "Yandex Cloud service";
  const cost =
    costField && costField.wire === 2 ? decimalMessage(costField.value) : 0;
  const expense =
    expenseField && expenseField.wire === 2
      ? decimalMessage(expenseField.value)
      : cost;

  return { name, cost, expense };
}

function currencyName(code: number, fallback: string) {
  if (code === 1) return "RUB";
  if (code === 2) return "USD";
  if (code === 3) return "KZT";
  if (code === 4) return "EUR";
  return fallback || "RUB";
}

function parseServiceUsageResponse(
  payload: Buffer,
  fallbackCurrency: string
) {
  const fields = decodeFields(payload);
  const currencyField = fields.find(
    (item) => item.field === 1 && item.wire === 0
  );
  const costField = fields.find((item) => item.field === 2 && item.wire === 2);
  const expenseField = fields.find(
    (item) => item.field === 4 && item.wire === 2
  );

  const services = fields
    .filter((item) => item.field === 5 && item.wire === 2)
    .flatMap((item) => {
      if (item.wire !== 2) return [];
      const parsed = parseServiceEntity(item.value);
      return parsed ? [parsed] : [];
    })
    .filter((item) => Math.abs(item.cost) > 0.0001 || Math.abs(item.expense) > 0.0001)
    .sort((a, b) => b.expense - a.expense || b.cost - a.cost);

  return {
    currency:
      currencyField && currencyField.wire === 0
        ? currencyName(Number(currencyField.value), fallbackCurrency)
        : fallbackCurrency,
    cost:
      costField && costField.wire === 2 ? decimalMessage(costField.value) : 0,
    expense:
      expenseField && expenseField.wire === 2
        ? decimalMessage(expenseField.value)
        : 0,
    services,
  };
}

async function grpcServiceUsage(
  iamToken: string,
  billingAccountId: string,
  startDate: Date,
  endDate: Date
) {
  const protobuf = encodeUsageReportRequest(
    billingAccountId,
    startDate,
    endDate
  );
  const frame = Buffer.alloc(5 + protobuf.length);
  frame[0] = 0;
  frame.writeUInt32BE(protobuf.length, 1);
  protobuf.copy(frame, 5);

  return await new Promise<Buffer>((resolve, reject) => {
    const client = connect(BILLING_GRPC_ORIGIN);
    const chunks: Buffer[] = [];
    let httpStatus = 0;
    let grpcStatus: string | undefined;
    let grpcMessage: string | undefined;

    client.on("error", reject);

    const request = client.request({
      ":method": "POST",
      ":path": BILLING_SERVICE_USAGE_PATH,
      "content-type": "application/grpc",
      te: "trailers",
      authorization: `Bearer ${iamToken}`,
      "grpc-timeout": "20S",
      "accept-language": "ru",
    });

    request.on("response", (headers) => {
      httpStatus = Number(headers[":status"] || 0);
      grpcStatus = headers["grpc-status"]?.toString();
      grpcMessage = headers["grpc-message"]?.toString();
    });

    request.on("trailers", (headers) => {
      grpcStatus = headers["grpc-status"]?.toString() || grpcStatus;
      grpcMessage = headers["grpc-message"]?.toString() || grpcMessage;
    });

    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

    request.on("error", (error) => {
      client.close();
      reject(error);
    });

    request.on("end", () => {
      client.close();

      if (httpStatus !== 200) {
        reject(new Error(`Yandex Billing gRPC HTTP status ${httpStatus}`));
        return;
      }

      if (grpcStatus && grpcStatus !== "0") {
        reject(
          new Error(
            `Yandex Billing gRPC failed: ${grpcStatus} ${grpcMessage || ""}`.trim()
          )
        );
        return;
      }

      try {
        const body = Buffer.concat(chunks);
        const messages: Buffer[] = [];
        let offset = 0;

        while (offset + 5 <= body.length) {
          const compressed = body[offset];
          const size = body.readUInt32BE(offset + 1);
          const start = offset + 5;
          const end = start + size;

          if (end > body.length) {
            throw new Error("Incomplete Yandex Billing gRPC frame");
          }

          if (compressed !== 0) {
            throw new Error("Compressed Yandex Billing gRPC response is unsupported");
          }

          messages.push(body.subarray(start, end));
          offset = end;
        }

        if (messages.length === 0) {
          throw new Error("Yandex Billing gRPC returned no message");
        }

        resolve(messages[0]);
      } catch (error) {
        reject(error);
      }
    });

    request.end(frame);
  });
}

export async function getYandexBillingSummary(): Promise<YandexBillingSummary> {
  if (billingCache && billingCache.expiresAtMs > Date.now()) {
    return billingCache.value;
  }

  const iamToken = await getIamToken();
  const account = await getBillingAccount(iamToken);
  const period = currentBillingPeriod();

  const response = await grpcServiceUsage(
    iamToken,
    account.id,
    period.start,
    period.end
  );
  const parsed = parseServiceUsageResponse(response, account.currency);

  const value: YandexBillingSummary = {
    billingAccountId: account.id,
    billingAccountName: account.name,
    currency: parsed.currency,
    cost: parsed.cost,
    expense: parsed.expense,
    monthKey: period.monthKey,
    services: parsed.services,
    fetchedAt: new Date().toISOString(),
  };

  billingCache = {
    expiresAtMs: Date.now() + BILLING_CACHE_MS,
    value,
  };

  return value;
}
