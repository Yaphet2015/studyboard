/** Only public HTTPS references can be opened from a card. */
export function isHttpsUrl(value: string): boolean {
  if (!/^https:\/\/[^\s<>"\\]+$/i.test(value)) return false;
  try {
    const url = new URL(value);
    return !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Legacy unlinked strings remain readable on disk but are never shown as citations. */
export function sourceLink(
  source?: string,
): { name: string; url: string } | undefined {
  const match = source?.trim().match(/^(.+?)\s+(https:\/\/\S+)$/i);
  if (!match || !isHttpsUrl(match[2])) return undefined;
  const name = match[1].replace(/[·：:|\s]+$/, "").trim();
  if (
    name.length < 2 ||
    /https?:|[<>]|项目.*记录|测量记录|内部|用户提供|模型|估算|待确认|未知|示例|不详|^来源$|^官网$|^网站$/i.test(
      name,
    )
  )
    return undefined;
  return { name, url: match[2] };
}
