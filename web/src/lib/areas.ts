// Iraq's governorates, used as the top level of an envelope's `area` ("baghdad/الكرادة").
export const GOVERNORATES: { slug: string; ar: string; en: string }[] = [
  { slug: 'baghdad', ar: 'بغداد', en: 'Baghdad' },
  { slug: 'basra', ar: 'البصرة', en: 'Basra' },
  { slug: 'nineveh', ar: 'نينوى', en: 'Nineveh' },
  { slug: 'erbil', ar: 'أربيل', en: 'Erbil' },
  { slug: 'sulaymaniyah', ar: 'السليمانية', en: 'Sulaymaniyah' },
  { slug: 'duhok', ar: 'دهوك', en: 'Duhok' },
  { slug: 'halabja', ar: 'حلبجة', en: 'Halabja' },
  { slug: 'kirkuk', ar: 'كركوك', en: 'Kirkuk' },
  { slug: 'anbar', ar: 'الأنبار', en: 'Anbar' },
  { slug: 'babil', ar: 'بابل', en: 'Babil' },
  { slug: 'karbala', ar: 'كربلاء', en: 'Karbala' },
  { slug: 'najaf', ar: 'النجف', en: 'Najaf' },
  { slug: 'wasit', ar: 'واسط', en: 'Wasit' },
  { slug: 'maysan', ar: 'ميسان', en: 'Maysan' },
  { slug: 'dhi-qar', ar: 'ذي قار', en: 'Dhi Qar' },
  { slug: 'muthanna', ar: 'المثنى', en: 'Muthanna' },
  { slug: 'qadisiyyah', ar: 'القادسية', en: 'Qadisiyyah' },
  { slug: 'diyala', ar: 'ديالى', en: 'Diyala' },
  { slug: 'salahaddin', ar: 'صلاح الدين', en: 'Salah al-Din' },
];

/** Turns a free-text neighbourhood name into an area segment ("حي الجامعة" → "حي-الجامعة"). */
export const slugify = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .slice(0, 32);
