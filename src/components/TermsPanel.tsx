import { useMemo, useRef, useState } from 'react';
import type { MergedCue } from '../lib/merge';
import { formatTimecode } from '../lib/srt';
import type { NormalizedCue, TermParseResult } from '../lib/terms';

const PAGE = 50;

interface TermsPanelProps {
  /** 上游最终合并字幕条数（只读，绝不修改合并结果） */
  sourceCount: number;
  /** 上游合并结果当前是否可导出（无未解决冲突 / 校验错误 / 非空） */
  sourceReady: boolean;
  /** 术语表原文（文本框，逐行 Tab 分隔） */
  termText: string;
  onTermText(text: string): void;
  /** 术语表解析结果 */
  parsed: TermParseResult;
  /** 逐条规范化结果（与上游字幕等长、同序，时间不变） */
  normalized: NormalizedCue<MergedCue>[];
  /** 序列化后的规范化 SRT 预览文本 */
  preview: string;
  /** 是否允许下载 terms.srt */
  canDownload: boolean;
  /** 不允许下载时的原因 */
  downloadReason: string;
  onDownload(): void;
}

const fmtRange = (start: number, end: number) =>
  `${formatTimecode(start)} → ${formatTimecode(end)}`;

export function TermsPanel(props: TermsPanelProps) {
  const { parsed, normalized, termText } = props;
  const [shown, setShown] = useState(PAGE);
  const fileRef = useRef<HTMLInputElement>(null);

  const nonEmptyLines = useMemo(
    () => termText.split('\n').filter((l) => l.trim().length > 0).length,
    [termText],
  );
  const hasError = parsed.invalid.length > 0;
  const changedCues = normalized.filter((n) => n.hits.length > 0);
  const hitCount = changedCues.reduce((n, c) => n + c.hits.length, 0);

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => props.onTermText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  /** 文本框内按 Tab 输入字面量 Tab（术语表列分隔符），而非转移焦点。 */
  const insertTab = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: en, value } = el;
    const next = value.slice(0, s) + '\t' + value.slice(en);
    props.onTermText(next);
    // 光标放到插入的 Tab 之后（需在值更新后）
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = s + 1;
    });
  };

  return (
    <section className="wrap-panel terms-panel">
      <div className="snap-input">
        <div className="snap-input-head">
          <strong>术语表（原词 → 替换词）</strong>
          <span className="tag dim">每行一条，两列用 Tab 分隔</span>
          <span className="spacer" />
          <button className="btn sm" onClick={() => fileRef.current?.click()}>
            上传术语表
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.tsv,.tab,text/plain,text/tab-separated-values"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) readFile(f);
              e.target.value = '';
            }}
          />
          {termText.length > 0 && (
            <button className="btn sm" onClick={() => props.onTermText('')}>
              清空
            </button>
          )}
        </div>
        <textarea
          className="snap-paste terms-paste"
          placeholder={'逐行填写术语，原词与替换词之间按 Tab 分隔，例如：\nwifi\tWi‑Fi\ni Phone\tiPhone\n区分大小写；列首尾空格也按字面量计入'}
          value={termText}
          spellCheck={false}
          onKeyDown={insertTab}
          onChange={(e) => props.onTermText(e.target.value)}
        />
        {nonEmptyLines > 0 && (
          <div className="snap-parse">
            {!hasError ? (
              <span className="tag ok">✓ 已解析 {parsed.rules.length} 条术语规则</span>
            ) : (
              <span className="tag warn">
                ⚠ 第 {parsed.invalid.map((b) => b.line).join('、')} 行格式错误
                {parsed.rules.length > 0 && `，其余 ${parsed.rules.length} 行已生效`}
              </span>
            )}
            {parsed.invalid.slice(0, 5).map((b) => (
              <span className="snap-badline" key={b.line} title={b.reason}>
                第 {b.line} 行：{b.raw === '' ? '（空）' : b.raw.replace(/\t/g, '⇥')}（{b.reason}）
              </span>
            ))}
            {parsed.invalid.length > 5 && (
              <span className="snap-badline">…等 {parsed.invalid.length} 行</span>
            )}
          </div>
        )}
      </div>

      <div className="wrap-summary">
        上游最终字幕 {props.sourceCount} 条（只读） · 术语规则 {parsed.rules.length} 条 ·
        命中共 {hitCount} 处 · 变更字幕 {changedCues.length} 条（未命中{' '}
        {normalized.length - changedCues.length} 条原样保留）
        <span className="wrap-hint">
          区分大小写、按字面量与 Unicode 字素匹配；自左向右取当前起点最长原词；标签与换行不参与匹配并原样保留；时间、条数与原合并结果不变
        </span>
      </div>

      {!props.sourceReady && (
        <div className="we-fail">
          ⚠ 上游合并结果当前不可导出（仍有未解决冲突或校验错误，或结果为空）。术语统一模块只读展示，修正上游前禁止下载 terms.srt。
        </div>
      )}

      <h3 className="panel-sub edit-sub">逐条对照（前：原文 · 后：术语统一）</h3>
      {normalized.length === 0 ? (
        <div className="empty">上游结果为空，没有需要规范化的字幕。</div>
      ) : (
        <>
          <div className="occ-table terms-table">
            {normalized.slice(0, shown).map((n, i) => (
              <div className={`terms-row ${n.hits.length > 0 ? 'hit' : 'same'}`} key={i}>
                <div className="terms-row-head">
                  <span className="g-idx">#{i + 1}</span>
                  <span className="mono occ-time">{fmtRange(n.cue.start, n.cue.end)}</span>
                  <span className="spacer" />
                  {n.hits.length > 0 ? (
                    <span className="tag low">命中 {n.hits.length} 处</span>
                  ) : (
                    <span className="tag dim">未命中 · 原样</span>
                  )}
                </div>
                <div className="terms-before" title={n.cue.text}>
                  <span className="terms-side-tag">前</span>
                  <span className="terms-text">{n.cue.text}</span>
                </div>
                <div className="terms-after" title={n.text}>
                  <span className="terms-side-tag">后</span>
                  <span className="terms-text">{n.text}</span>
                </div>
                {n.hits.length > 0 && (
                  <div className="terms-rules">
                    {n.hits.map((h, hi) => (
                      <span className="tag dim terms-rule" key={hi} title={`术语表第 ${h.rule.line} 行`}>
                        {h.rule.from} → {h.rule.to}
                        <em>（第 {h.rule.line} 行）</em>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          {normalized.length > shown && (
            <button className="btn more" onClick={() => setShown((v) => v + PAGE)}>
              显示更多（剩余 {normalized.length - shown} 条）
            </button>
          )}
        </>
      )}

      <h3 className="panel-sub edit-sub">规范化字幕预览（terms.srt，序号与时间不变）</h3>
      {parsed.rules.length === 0 ? (
        <div className="empty">
          请逐行填写术语表（原词与替换词两列用 Tab 分隔；在文本框中按 Tab 即可输入分列符），系统将立即生成规范化字幕副本。
        </div>
      ) : (
        <pre className="preview edit-preview">{props.preview || '（暂无内容）'}</pre>
      )}

      <button
        className="btn primary lg block"
        disabled={!props.canDownload}
        title={props.canDownload ? '下载 terms.srt' : props.downloadReason}
        onClick={props.onDownload}
      >
        {props.canDownload ? '下载术语统一 SRT' : props.downloadReason || '暂不可下载'}
      </button>
    </section>
  );
}
