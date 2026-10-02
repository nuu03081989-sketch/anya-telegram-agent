export const WARDROBE_MOODBOARD_SYSTEM_RULE =
  "Если Аня просит визуальные подборки цветовых сочетаний для гардероба, приоритетный формат — Pinterest-style fashion moodboard: коллаж с 1–2 женскими образами или предметами одежды, цветовой палитрой/Pantone, аксессуарами и фактурами в тех же оттенках. В каждом результате должны читаться все основные цвета сочетания. Не подменяй гардеробную подборку интерьером, едой, цветами или абстрактной палитрой без одежды.";

type ColorRule = {
  pattern: RegExp;
  value: string;
};

const COLOR_RULES: ColorRule[] = [
  { pattern: /\bсливк(?:а|и|ой|овый|ового|овому|овым|овом)?\b/gi, value: "cream" },
  { pattern: /\bсливов(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "plum" },
  { pattern: /\bтерракотов(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "terracotta" },
  { pattern: /\bсер(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "gray" },
  { pattern: /\bкрасн(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "red" },
  { pattern: /\bч[её]рн(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "black" },
  { pattern: /\bж[её]лт(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "yellow" },
  { pattern: /\bбел(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "white" },
  { pattern: /\bзел[её]н(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "green" },
  { pattern: /\bкоричнев(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "brown" },
  { pattern: /\bбежев(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "beige" },
  { pattern: /\bмолочн(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "ivory" },
  { pattern: /\bайвори\b/gi, value: "ivory" },
  { pattern: /\bбордов(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "burgundy" },
  { pattern: /\bвинн(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "wine" },
  { pattern: /\bоливков(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "olive" },
  { pattern: /\bхаки\b/gi, value: "khaki" },
  { pattern: /\bсин(?:ий|его|ему|им|ем|яя|ей|юю|ее|ие|их|ими)?\b/gi, value: "blue" },
  { pattern: /\bголуб(?:ой|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "light blue" },
  { pattern: /\bт[её]мно[-\s]?син(?:ий|его|ему|им|ем)?\b/gi, value: "navy" },
  { pattern: /\bлавандов(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "lavender" },
  { pattern: /\bфиолетов(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "purple" },
  { pattern: /\bрозов(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "pink" },
  { pattern: /\bоранжев(?:ый|ого|ому|ым|ом|ая|ой|ую|ое|ые|ых|ыми)?\b/gi, value: "orange" },
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
