import { escapeBlessed } from './format.js';
import { renderLocalUsage } from './local-usage.js';
import { COLOR } from './palette.js';
import { formatUsageItem, formatUsageItemCompact } from './render.js';

// Shared renderer for providers with a single account. Provider modules own
// their auth and quota mapping; this module owns only presentation.
export function renderSingleAccount(snapshot, width, mode, _name, localOpts) {
  if (snapshot.fatal) {
    return `  {${COLOR.danger}-fg}${escapeBlessed(snapshot.fatal)}{/${COLOR.danger}-fg}`;
  }

  const compact = mode === 'compact';
  const status = snapshot.ok
    ? `{${COLOR.success}-fg}{bold}OK{/bold}{/${COLOR.success}-fg}`
    : `{${COLOR.danger}-fg}{bold}${escapeBlessed(String(snapshot.status))}{/bold}{/${COLOR.danger}-fg}`;
  // The account email is identifying, so it only shows in the detail view.
  const meta = (compact
    ? [snapshot.plan]
    : [snapshot.plan, snapshot.email, `${snapshot.ms}ms`]).filter(Boolean).join(' · ');
  const metaText = meta ? `  {${COLOR.muted}-fg}${escapeBlessed(meta)}{/${COLOR.muted}-fg}` : '';
  const lines = [`  ${status}${metaText}`];

  if (!snapshot.ok) {
    lines.push(`  {${COLOR.danger}-fg}${escapeBlessed(snapshot.error || 'unknown error')}{/${COLOR.danger}-fg}`);

    if (snapshot.body && !compact) {
      lines.push(`  {${COLOR.muted}-fg}${escapeBlessed(snapshot.body)}{/${COLOR.muted}-fg}`);
    }
  } else {
    const itemFormatter = compact ? formatUsageItemCompact : formatUsageItem;
    const items = compact ? snapshot.items.filter((item) => !item.detailOnly) : snapshot.items;
    lines.push(...items.map((item) => itemFormatter(item, width)));
  }

  if (snapshot.local && !compact) {
    lines.push('', renderLocalUsage(snapshot.local, { ...localOpts, width }));
  }

  return lines.join('\n');
}
