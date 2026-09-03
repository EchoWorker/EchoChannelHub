const INTERNAL_BLOCKS = [
  /<thinking>[\s\S]*?<\/thinking>/gi,
  /<analysis>[\s\S]*?<\/analysis>/gi,
  /<reminder>[\s\S]*?<\/reminder>/gi,
  /<system_reminder>[\s\S]*?<\/system_reminder>/gi,
];

export function sanitizeQQText(value: string): string {
  let text = value;
  for (const pattern of INTERNAL_BLOCKS) text = text.replace(pattern, "");
  return text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").trim();
}
