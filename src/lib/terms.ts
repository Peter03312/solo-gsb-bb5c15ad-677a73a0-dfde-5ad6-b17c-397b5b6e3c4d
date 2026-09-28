/**
 * 术语统一（独立模块）：读取现有最终合并字幕（finalCues），按术语表生成规范化
 * 字幕副本。只读取上游结果，绝不修改合并结果本身（时间、条数均不变）。
 *
 * 术语表：
 *   - 逐行用 **Tab** 分隔为“原词 → 替换词”两列；
 *   - 两列均须非空、且都不得包含形如 <...> 的标签；
 *   - 原词不得重复（逐字、区分大小写比较）；列数错误（不是恰好两列）按行提示；
 *   - 空行忽略；列内容不做 trim（首尾空格是字面量的一部分）。
 *
 * 匹配规则：
 *   - 区分大小写，按**字面量**与 **Unicode 字素簇**匹配；
 *   - 形如 <...> 的标签与换行（\r、\n）不参与匹配，但保留在输出的原位置；
 *     即命中段可以跨越标签/换行，其中的标签与换行原样保留；
 *   - 自左向右扫描，在当前起点选择**最长**的可命中原词；命中后越过整段；
 *   - 在命中段的**首个命中字素**处插入替换词，并删去其余命中字素；
 *     替换内容原样输出，不再参与后续匹配。
 */
import { graphemes } from './wrap';

export interface TermRule {
  /** 物理行号（从 1 起，空行也计入，与文本框行号一致） */
  line: number;
  /** 原词（不 trim；不含 Tab/换行/标签） */
  from: string;
  /** 替换词（不 trim；不含 Tab/换行/标签） */
  to: string;
}

export interface BadTermLine {
  /** 物理行号（从 1 起） */
  line: number;
  raw: string;
  /** 错误原因 */
  reason: string;
}

export interface TermParseResult {
  /** 解析成功的术语规则（保持填写顺序） */
  rules: TermRule[];
  /** 格式错误的行（列数错误 / 列空 / 含标签 / 原词重复） */
  invalid: BadTermLine[];
  /** 非空物理行总数（含错误行） */
  totalLines: number;
}

/** 形如 <...> 的标签：以 < 开头、最近一个 > 结尾，中间可含任意字符（除换行）。 */
const TAG_RE = /<[^>\r\n]*>/g;

/** 列内出现完整标签（<...>）即非法；未闭合的尖括号按字面量处理。 */
function containsTag(s: string): boolean {
  return TAG_RE.test(s);
}

/**
 * 解析术语表：每行必须用 Tab 恰好分成两列，两列非空且不含标签，
 * 原词不得重复（逐字比较、区分大小写）。空行忽略。
 */
export function parseTerms(text: string): TermParseResult {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rules: TermRule[] = [];
  const invalid: BadTermLine[] = [];
  const seen = new Set<string>();
  let totalLines = 0;

  normalized.split('\n').forEach((raw, idx) => {
    if (raw.trim() === '') return;
    totalLines++;
    const line = idx + 1;
    // 列数以 Tab 计：恰好一个 Tab 分隔成两列，空列也算一列
    const tabCount = (raw.match(/\t/g) ?? []).length;
    if (tabCount !== 1) {
      invalid.push({
        line,
        raw,
        reason: tabCount === 0 ? '需要用 Tab 分隔原词与替换词两列' : '每行只能有原词与替换词两列',
      });
      return;
    }
    const [from, to] = raw.split('\t');
    if (from.length === 0 || to.length === 0) {
      invalid.push({ line, raw, reason: '原词与替换词两列均须非空' });
      return;
    }
    if (containsTag(from) || containsTag(to)) {
      invalid.push({ line, raw, reason: '原词与替换词均不得包含标签（<...>）' });
      return;
    }
    if (seen.has(from)) {
      invalid.push({ line, raw, reason: '原词重复' });
      return;
    }
    seen.add(from);
    rules.push({ line, from, to });
  });

  return { rules, invalid, totalLines };
}

/** 匹配序列中的原子：普通字素（参与匹配）或不参与匹配的标签 / 换行（原样保留）。 */
export interface TermToken {
  kind: 'text' | 'tag' | 'newline';
  value: string;
}

/** 把文本切成匹配序列：<...> 标签与换行各自成段且不参与匹配，其余按字素簇切分。 */
export function tokenizeForTerms(text: string): TermToken[] {
  const tokens: TermToken[] = [];
  const skipRe = /<[^>\r\n]*>|\r\n?|\n/g;
  let last = 0;
  for (const m of text.matchAll(skipRe)) {
    const idx = m.index ?? 0;
    if (idx > last) for (const g of graphemes(text.slice(last, idx))) tokens.push({ kind: 'text', value: g });
    tokens.push({ kind: m[0].startsWith('<') ? 'tag' : 'newline', value: m[0] });
    last = idx + m[0].length;
  }
  if (last < text.length) for (const g of graphemes(text.slice(last))) tokens.push({ kind: 'text', value: g });
  return tokens;
}

export interface TermHit {
  /** 命中的术语规则 */
  rule: TermRule;
  /** 命中段在 token 序列中的 [起, 止) */
  start: number;
  end: number;
}

export interface NormalizedCue<T = unknown> {
  /** 规范化后的文本（标签与换行原样保留） */
  text: string;
  /** 命中规则（按出现顺序，跨越标签/换行的命中各计一次） */
  hits: TermHit[];
  /** 透传的原字幕（取时间等） */
  cue: T;
}

/**
 * 对一条文本执行术语替换：自左向右、当前起点取最长原词；命中后越过整段，
 * 在首个命中字素处放替换词、删去其余命中字素；标签/换行原样保留。
 */
export function normalizeText(text: string, rules: TermRule[]): { text: string; hits: TermHit[] } {
  const tokens = tokenizeForTerms(text);
  // 原词按首字素分组并按长度降序；每个起点只需试到第一个完整命中即最长
  const byFirst = new Map<string, { rule: TermRule; atoms: string[] }[]>();
  for (const rule of rules) {
    const atoms = graphemes(rule.from);
    const list = byFirst.get(atoms[0]) ?? [];
    list.push({ rule, atoms });
    byFirst.set(atoms[0], list);
  }
  for (const list of byFirst.values()) list.sort((a, b) => b.atoms.length - a.atoms.length);

  /** 在 token i 处尝试按字素序列匹配（跳过 tag/newline）。 */
  const matchAt = (i: number): { rule: TermRule; end: number } | null => {
    const t = tokens[i];
    if (t.kind !== 'text') return null;
    const candidates = byFirst.get(t.value);
    if (!candidates) return null;
    outer: for (const { rule, atoms } of candidates) {
      let ti = i;
      let ai = 0;
      while (ai < atoms.length) {
        while (ti < tokens.length && tokens[ti].kind !== 'text') ti++;
        if (ti >= tokens.length || tokens[ti].value !== atoms[ai]) continue outer;
        ti++;
        ai++;
      }
      return { rule, end: ti };
    }
    return null;
  };

  // output[i]：text token i 的输出标记。tag/newline 始终原样输出。
  const replacedAt = new Map<number, string>();
  const consumed = new Set<number>();
  const hits: TermHit[] = [];
  let i = 0;
  while (i < tokens.length) {
    const m = matchAt(i);
    if (m) {
      replacedAt.set(i, m.rule.to);
      // 删去其余命中字素（跳过的 tag/newline 不动）
      for (let j = i + 1; j < m.end; j++) if (tokens[j].kind === 'text') consumed.add(j);
      hits.push({ rule: m.rule, start: i, end: m.end });
      i = m.end; // 命中后越过该段；替换内容不再参与匹配
    } else {
      i++;
    }
  }

  let out = '';
  for (let j = 0; j < tokens.length; j++) {
    if (tokens[j].kind !== 'text') {
      out += tokens[j].value;
    } else if (replacedAt.has(j)) {
      out += replacedAt.get(j);
    } else if (!consumed.has(j)) {
      out += tokens[j].value;
    }
  }
  return { text: out, hits };
}

/** 对一批字幕逐条生成规范化副本；时间与条数不变，文本按术语表替换。 */
export function buildTermsCues<T extends { start: number; end: number; text: string }>(
  cues: readonly T[],
  rules: TermRule[],
): NormalizedCue<T>[] {
  return cues.map((cue) => {
    const { text, hits } = normalizeText(cue.text, rules);
    return { text, hits, cue };
  });
}
