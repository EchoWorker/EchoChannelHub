export const locales = ["en", "zh-CN"];

export const taxonomy = Object.freeze({
  categories: Object.freeze({ messaging: { en: "Messaging", "zh-CN": "即时通讯" } }),
  tags: Object.freeze({ wechat: { en: "WeChat", "zh-CN": "微信" }, social: { en: "Social", "zh-CN": "社交" } }),
  capabilities: Object.freeze({ text: { en: "Text messages", "zh-CN": "文本消息" }, image: { en: "Images", "zh-CN": "图片" }, audio: { en: "Audio", "zh-CN": "音频" }, setup: { en: "Guided setup", "zh-CN": "引导式设置" } }),
  trust: Object.freeze({ community: { en: "Community maintained", "zh-CN": "社区维护" }, verified: { en: "Publisher verified", "zh-CN": "发布者已验证" } })
});

export function validateLocalized(value, at, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return errors.push(`${at}: localized object required`);
  for (const key of Object.keys(value)) if (!locales.includes(key)) errors.push(`${at}: unsupported locale ${key}`);
  for (const locale of locales) if (typeof value[locale] !== "string" || !value[locale].trim()) errors.push(`${at}.${locale}: non-empty string required`);
}

export function validateSemantics(manifest, at, errors) {
  validateLocalized(manifest.description, `${at}.description`, errors);
  validateLocalized(manifest.details, `${at}.details`, errors);
  if (!taxonomy.categories[manifest.category]) errors.push(`${at}.category: unknown taxonomy term`);
  for (const field of ["tags", "capabilities"]) {
    if (!Array.isArray(manifest[field]) || !manifest[field].length) errors.push(`${at}.${field}: non-empty array required`);
    else {
      if (new Set(manifest[field]).size !== manifest[field].length) errors.push(`${at}.${field}: duplicate terms`);
      for (const term of manifest[field]) if (!taxonomy[field][term]) errors.push(`${at}.${field}: unknown taxonomy term ${term}`);
    }
  }
  if (!manifest.trust || typeof manifest.trust !== "object" || Array.isArray(manifest.trust)) errors.push(`${at}.trust: object required`);
  else {
    for (const key of Object.keys(manifest.trust)) if (!["level", "source", "reviewedAt"].includes(key)) errors.push(`${at}.trust: unknown property ${key}`);
    if (!taxonomy.trust[manifest.trust.level]) errors.push(`${at}.trust.level: unknown taxonomy term`);
    if (typeof manifest.trust.source !== "string" || !manifest.trust.source) errors.push(`${at}.trust.source: required`);
    if (!Number.isFinite(Date.parse(manifest.trust.reviewedAt))) errors.push(`${at}.trust.reviewedAt: date-time required`);
  }
  if (manifest.tags && [...manifest.tags].sort().join("\0") !== manifest.tags.join("\0")) errors.push(`${at}.tags: must be sorted`);
  if (manifest.capabilities && [...manifest.capabilities].sort().join("\0") !== manifest.capabilities.join("\0")) errors.push(`${at}.capabilities: must be sorted`);
}

export function taxonomyDocument(kind) {
  if (!["categories", "tags"].includes(kind)) throw new Error(`unsupported taxonomy: ${kind}`);
  return { schemaVersion: 1, kind, terms: Object.entries(taxonomy[kind]).sort(([a], [b]) => a.localeCompare(b)).map(([id, label]) => ({ id, label })) };
}
