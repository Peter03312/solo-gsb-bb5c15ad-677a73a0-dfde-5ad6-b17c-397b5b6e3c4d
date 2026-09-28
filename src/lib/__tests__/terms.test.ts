import { describe, expect, it } from 'vitest';
import {
  buildTermsCues,
  normalizeText,
  parseTerms,
  tokenizeForTerms,
} from '../terms';

describe('parseTerms 术语表解析', () => {
  it('逐行 Tab 分隔两列，保持填写顺序，行号为物理行', () => {
    const r = parseTerms('wifi\tWi‑Fi\n\ni Phone\tiPhone\n');
    expect(r.invalid).toEqual([]);
    expect(r.totalLines).toBe(2);
    expect(r.rules.map((x) => [x.from, x.to])).toEqual([
      ['wifi', 'Wi‑Fi'],
      ['i Phone', 'iPhone'],
    ]);
    expect(r.rules.map((x) => x.line)).toEqual([1, 3]);
  });

  it('列首尾空格不 trim，按字面量保留', () => {
    const r = parseTerms(' a \t b');
    expect(r.invalid).toEqual([]);
    expect(r.rules[0].from).toBe(' a ');
    expect(r.rules[0].to).toBe(' b');
  });

  it('无 Tab 或多于一个 Tab 报列数错误', () => {
    const r = parseTerms('abc\ta\tb\nnotab\nx\ty\nz\ta\tb\tc');
    expect(r.rules.map((x) => x.from)).toEqual(['x']);
    expect(r.invalid.map((b) => b.line)).toEqual([1, 2, 4]);
    expect(r.invalid[0].reason).toContain('两列');
    expect(r.invalid[1].reason).toContain('Tab');
  });

  it('空列报错（原词或替换词为空）；列内空格按字面量保留', () => {
    const r = parseTerms('\tb\na\t\n \tb\nx\ty');
    expect(r.rules.map((x) => [x.from, x.to])).toEqual([
      [' ', 'b'],
      ['x', 'y'],
    ]);
    expect(r.invalid.map((b) => b.line)).toEqual([1, 2]);
  });

  it('列中含标签报错，未闭合尖括号不算标签', () => {
    const r = parseTerms('<i>a</i>\tA\nb\t<b>\nc<\tC\nd>\tD');
    expect(r.rules.map((x) => x.from).sort()).toEqual(['c<', 'd>']);
    expect(r.invalid.map((b) => b.line)).toEqual([1, 2]);
  });

  it('重复原词按行报错（区分大小写）', () => {
    const r = parseTerms('abc\tX\nABC\tY\nabc\tZ\n');
    expect(r.rules.map((x) => x.from)).toEqual(['abc', 'ABC']);
    expect(r.invalid.map((b) => b.line)).toEqual([3]);
    expect(r.invalid[0].reason).toBe('原词重复');
  });

  it('空文本与空行', () => {
    const r = parseTerms('\n  \n\t\n');
    expect(r.rules).toEqual([]);
    expect(r.invalid).toEqual([]);
    expect(r.totalLines).toBe(0);
  });
});

describe('tokenizeForTerms 匹配序列', () => {
  it('标签与换行各自成段且不参与匹配，文本按字素切分', () => {
    const ts = tokenizeForTerms('a<i>b</i>\nc');
    expect(ts.map((t) => [t.kind, t.value])).toEqual([
      ['text', 'a'],
      ['tag', '<i>'],
      ['text', 'b'],
      ['tag', '</i>'],
      ['newline', '\n'],
      ['text', 'c'],
    ]);
  });

  it('CRLF 作为一个换行段；标签内不允许跨换行', () => {
    const ts = tokenizeForTerms('<i\r\nx>');
    expect(ts.map((t) => [t.kind, t.value])).toEqual([
      ['text', '<'],
      ['text', 'i'],
      ['newline', '\r\n'],
      ['text', 'x'],
      ['text', '>'],
    ]);
  });

  it('组合 emoji 字素簇作为一个匹配原子', () => {
    const ts = tokenizeForTerms('a👨‍👩‍👧b');
    expect(ts.filter((t) => t.kind === 'text').map((t) => t.value)).toEqual(['a', '👨‍👩‍👧', 'b']);
  });
});

describe('normalizeText 术语替换', () => {
  const rulesOf = (text: string) => parseTerms(text).rules;

  it('区分大小写的字面量替换', () => {
    const rules = rulesOf('abc\tXYZ\nABC\t大写');
    expect(normalizeText('abc ABC ab abc', rules).text).toBe('XYZ 大写 ab XYZ');
  });

  it('自左向右取当前起点最长原词', () => {
    const rules = rulesOf('a\t一\nab\t二\nabc\t三');
    expect(normalizeText('abc', rules).text).toBe('三');
    expect(normalizeText('xabc', rules).text).toBe('x三');
    expect(normalizeText('aab', rules).text).toBe('一二');
    // 在位置 0 “abcx”完整不命中时回退试较短原词 “ab”
    const rules2 = rulesOf('ab\t二\nabcx\t四');
    expect(normalizeText('abc', rules2).text).toBe('二c');
  });

  it('命中后越过该段，替换内容不再参与匹配', () => {
    // 原词 “x” 替换为 “bb”；替换产生的 bb 不会再去匹配原词 “bb”
    const rules = rulesOf('x\tbb\nbb\t中');
    expect(normalizeText('xbbx', rules).text).toBe('bb中bb');
    expect(normalizeText('x', rules).text).toBe('bb');
  });

  it('在首个命中字素处插入替换词并删去其余命中字素', () => {
    const rules = rulesOf('abc\tX');
    expect(normalizeText('zabcz', rules).text).toBe('zXz');
  });

  it('标签不参与匹配但原样保留，命中可跨越标签', () => {
    const rules = rulesOf('abc\tX');
    expect(normalizeText('a<i>bc</i>', rules).text).toBe('X<i></i>');
    expect(normalizeText('<b>abc</b>', rules).text).toBe('<b>X</b>');
    expect(normalizeText('ab<c', rules).text).toBe('ab<c');
  });

  it('换行不参与匹配但原样保留，命中可跨越换行', () => {
    const rules = rulesOf('abc\tX');
    expect(normalizeText('a\nbc', rules).text).toBe('X\n');
    expect(normalizeText('a\r\nbc', rules).text).toBe('X\r\n');
  });

  it('命中段内的多个标签与换行全部保留', () => {
    const rules = rulesOf('abcd\t词');
    expect(normalizeText('a<i>b</i>c\nd', rules).text).toBe('词<i></i>\n');
  });

  it('hits 记录命中规则（行号）与位置，按出现顺序', () => {
    const rules = rulesOf('ab\tX');
    const r = normalizeText('ab ab', rules);
    expect(r.hits).toHaveLength(2);
    expect(r.hits[0].rule.line).toBe(1);
    expect(r.text).toBe('X X');
  });

  it('Unicode 字素：组合 emoji 整体命中', () => {
    const rules = rulesOf('👨‍👩‍👧\t家庭');
    expect(normalizeText('👨‍👩‍👧好', rules).text).toBe('家庭好');
    expect(normalizeText('👨好', rules).text).toBe('👨好');
  });

  it('空规则表原样返回', () => {
    expect(normalizeText('原样\n<b>x</b>', []).text).toBe('原样\n<b>x</b>');
  });
});

describe('buildTermsCues 规范化副本', () => {
  it('时间与条数不变，仅文本被替换', () => {
    const cues = [
      { start: 0, end: 1000, text: 'abc', groupIndex: 0 },
      { start: 1000, end: 2000, text: '无关', groupIndex: 1 },
    ];
    const rules = parseTerms('abc\tX').rules;
    const out = buildTermsCues(cues, rules);
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe('X');
    expect(out[0].cue.start).toBe(0);
    expect(out[0].cue.end).toBe(1000);
    expect(out[1].text).toBe('无关');
    expect(out[1].hits).toEqual([]);
    expect(out[1].cue).toBe(cues[1]);
  });
});
