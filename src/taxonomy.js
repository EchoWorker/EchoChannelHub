export const locales = ["en", "zh-CN"];

export const taxonomy = Object.freeze({
  categories: Object.freeze({
    messaging: { order: 10, labels: { en: "Messaging", "zh-CN": "即时通讯" }, deprecated: false, replacedBy: null, aliases: [] },
    enterprise: { order: 20, labels: { en: "Enterprise", "zh-CN": "企业" }, deprecated: false, replacedBy: null, aliases: [] },
    automation: { order: 30, labels: { en: "Automation", "zh-CN": "自动化" }, deprecated: false, replacedBy: null, aliases: [] },
    developer: { order: 40, labels: { en: "Developer", "zh-CN": "开发者" }, deprecated: false, replacedBy: null, aliases: [] },
    other: { order: 1000, labels: { en: "Other", "zh-CN": "其他" }, deprecated: false, replacedBy: null, aliases: [] }
  }),
  tags: Object.freeze({
    "direct-message": { group: "scenario", order: 10, labels: { en: "Direct message", "zh-CN": "私聊" }, deprecated: false, aliases: [] },
    media: { group: "capability", order: 20, labels: { en: "Media", "zh-CN": "媒体" }, deprecated: false, aliases: [] },
    "multi-account": { group: "capability", order: 30, labels: { en: "Multi-account", "zh-CN": "多账号" }, deprecated: false, aliases: [] }
  }),
  capabilities: Object.freeze({ receive: true, send: true, media: true }),
  trust: Object.freeze({ community: true, official: true })
});

export function validateLocalized(value, at, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return errors.push(`${at}: localized object required`);
  for (const key of Object.keys(value)) if (!locales.includes(key)) errors.push(`${at}: unsupported locale ${key}`);
  for (const locale of locales) if (typeof value[locale] !== "string" || !value[locale].trim()) errors.push(`${at}.${locale}: non-empty string required`);
}

export function validateSemantics(manifest, at, errors) {
  validateLocalized(manifest.name, `${at}.name`, errors);
  validateLocalized(manifest.summary, `${at}.summary`, errors);
  if (!Array.isArray(manifest.categoryIds) || !manifest.categoryIds.length) errors.push(`${at}.categoryIds: non-empty array required`);
  else for (const term of manifest.categoryIds) if (!taxonomy.categories[term]) errors.push(`${at}.categoryIds: unknown taxonomy term ${term}`);
  for (const field of ["tagIds", "capabilities"]) {
    if (!Array.isArray(manifest[field]) || !manifest[field].length) errors.push(`${at}.${field}: non-empty array required`);
    else {
      if (new Set(manifest[field]).size !== manifest[field].length) errors.push(`${at}.${field}: duplicate terms`);
      for (const term of manifest[field]) {
        const vocabulary = field === "tagIds" ? taxonomy.tags : taxonomy[field];
        if (!vocabulary[term]) errors.push(`${at}.${field}: unknown taxonomy term ${term}`);
      }
    }
  }
  if (!taxonomy.trust[manifest.publisherTrust]) errors.push(`${at}.publisherTrust: unknown trust level`);
  for (const field of ["categoryIds", "tagIds", "capabilities", "aliases"]) if (manifest[field] && [...manifest[field]].sort().join("\0") !== manifest[field].join("\0")) errors.push(`${at}.${field}: must be sorted`);
}

export function taxonomyDocument(kind) {
  if (!['categories', 'tags'].includes(kind)) throw new Error(`unsupported taxonomy: ${kind}`);
  const values = Object.entries(taxonomy[kind]).sort(([, a], [, b]) => a.order - b.order).map(([id, value]) => ({ id, ...value }));
  return { [kind]: values };
}
