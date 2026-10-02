export const WARDROBE_MOODBOARD_SYSTEM_RULE =
  "Если Аня просит визуальные подборки цветовых сочетаний для гардероба, приоритетный формат — Pinterest-style fashion moodboard: коллаж с 1–2 женскими образами или предметами одежды, цветовой палитрой/Pantone, аксессуарами и фактурами в тех же оттенках. В каждом результате должны читаться все основные цвета сочетания. Не подменяй гардеробную подборку интерьером, едой, цветами или абстрактной палитрой без одежды.";

type ColorRule = {
  pattern: RegExp;
  value: string;
};

const COLOR_RULES: ColorRule[] = [
  { pattern: /сливк(?:а|и|ой|овый|ового|овому|овым|овом)?/gi, value: "cream" },
  { pattern: /сливов(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "plum" },
  { pattern: /терракотов(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "terracotta" },
  { pattern: /сер(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "gray" },
  { pattern: /красн(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "red" },
  { pattern: /ч[её]рн(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "black" },
  { pattern: /ж[её]лт(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "yellow" },
  { pattern: /бел(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "white" },
  { pattern: /зел[её]н(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "green" },
  { pattern: /коричнев(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "brown" },
  { pattern: /бежев(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "beige" },
  { pattern: /молочн(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "ivory" },
  { pattern: /айвори/gi, value: "ivory" },
  { pattern: /бордов(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "burgundy" },
  { pattern: /винн(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "wine" },
  { pattern: /оливков(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "olive" },
  { pattern: /хаки/gi, value: "khaki" },
  { pattern: /син(?:ий|его|ему|им|ем|яя|ей|юю|ее|ие|их|ими)?/gi, value: "blue" },
  { pattern: /голуб(?:ой|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "light blue" },
  { pattern: /т[её]мно[-\s]?син(?:ий|его|ему|им|ем)?/gi, value: "navy" },
  { pattern: /лавандов(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "lavender" },
  { pattern: /фиолетов(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "purple" },
  { pattern: /розов(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "pink" },
  { pattern: /оранжев(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?/gi, value: "orange" },
];

function compactText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function wardrobeCombinationTitle(item: string) {
  const compact = compactText(item);
  const beforeExplanation =
    compact.match(/^(.{2,90}?)(?::|\s[-–—]\s)/)?.[1]?.trim() || compact;

  return beforeExplanation.replace(/[.;,]+$/g, "").trim().slice(0, 90);
}

export function translateWardrobeColors(title: string) {
  const found: string[] = [];

  for (const rule of COLOR_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(title)) {
      found.push(rule.value);
    }
  }

  return Array.from(new Set(found));
}

export function buildWardrobeMoodboardSearch(item: string, index: number) {
  const title = wardrobeCombinationTitle(item);
  const translated = translateWardrobeColors(title);
  const colorPhrase =
    translated.length >= 2 ? translated.join(" ") : compactText(title);

  const query = [
    "pinterest style fashion moodboard",
    "women outfit clothing collage",
    colorPhrase,
    "wardrobe color palette pantone",
    "accessories textures aesthetic editorial",
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 320)
    .trim();

  const fallbackQuery = [
    "women fashion outfit moodboard collage",
    colorPhrase,
    "color combination wardrobe palette pinterest",
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 320)
    .trim();

  return {
    label: `Вариант ${index + 1}: ${title}`,
    query,
    fallbackQuery,
    title,
    colors: translated,
  };
}
