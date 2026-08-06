import { readFile } from 'node:fs/promises';

export interface StaticAsset {
  contentType: string;
  content: Buffer;
}

// 自检页情况示意图占位：文件名白名单 → 仓库静态文件与内容类型。
// 图片素材与图示内容由后续单独提供，这里只承载占位文件与固定前缀服务；
// 白名单查找天然阻断路径穿越，未知文件名一律 404。
const SELF_CHECK_ILLUSTRATION_FILES = ['situation-1.svg', 'situation-2.svg', 'situation-3.svg'];
const SELF_CHECK_ILLUSTRATION_CONTENT_TYPE = 'image/svg+xml';

/** 自检页情况示意图静态资源：启动时一次性读入内存，随部署加载。 */
export async function loadSelfCheckIllustrations(): Promise<Map<string, StaticAsset>> {
  const assets = new Map<string, StaticAsset>();
  for (const name of SELF_CHECK_ILLUSTRATION_FILES) {
    const content = await readFile(new URL(`../public/self-check/${name}`, import.meta.url));
    assets.set(name, { contentType: SELF_CHECK_ILLUSTRATION_CONTENT_TYPE, content });
  }
  return assets;
}
