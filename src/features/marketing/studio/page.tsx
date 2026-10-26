/** Studio › Marketing (#/marketing/<tab>): campaigns, automations, audiences and the inbox. */
import React from 'react';
import { useData } from '../../../shared/react';
import { PageHead, cx, replaceRoute, useStudio } from '../../../studio/ui';
import { marketing } from '../api';
import { AudiencesTab } from './audiences';
import { AutomationsTab } from './automations';
import { CampaignsTab } from './campaigns';
import { InboxTab, useInboxLive } from './inbox';

const TABS = [
  { key: 'campaigns', label: 'Campaigns', perm: 'marketing.view' },
  { key: 'automations', label: 'Automations', perm: 'marketing.view' },
  { key: 'audiences', label: 'Audiences', perm: 'marketing.view' },
  { key: 'inbox', label: 'Inbox', perm: 'marketing.inbox' },
];

export function MarketingPage({ tab, id }: { tab?: string; id?: string }) {
  const { can } = useStudio();
  const tabs = TABS.filter((t) => can(t.perm));
  const cur = tabs.find((t) => t.key === tab)?.key ?? tabs[0]?.key ?? 'campaigns';
  const unread = useData(async () => (can('marketing.inbox') ? await marketing()?.inboxUnreadCount() ?? 0 : 0), []);
  useInboxLive(unread.reload);
  return (
    <div className="mk-page">
      <PageHead eyebrow="Marketing" title={<>Stay in <em>touch</em></>} sub="Campaigns, messages that send themselves, and your client inbox." />
      <nav className="tabs" aria-label="Marketing sections">
        {tabs.map((t) => (
          <a key={t.key} href={`#/marketing/${t.key}`} className={cx(cur === t.key && 'on')} aria-current={cur === t.key ? 'page' : undefined}
            onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); replaceRoute(`/marketing/${t.key}`); }}>
            {t.label}{t.key === 'inbox' && (unread.data ?? 0) > 0 && <span className="mk-badge">{unread.data}</span>}
          </a>
        ))}
      </nav>
      {cur === 'campaigns' && <CampaignsTab />}
      {cur === 'automations' && <AutomationsTab />}
      {cur === 'audiences' && <AudiencesTab />}
      {cur === 'inbox' && <InboxTab {...(id ? { clientId: id } : {})} />}
    </div>
  );
}
