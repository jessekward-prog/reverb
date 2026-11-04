import React from 'react';
import ReportView from './ReportView.jsx';

export default function LifeView({ auth, onLockout, onOpenChat, onOpenSweep, onOpenTasks, onOpenWork, onOpenTexts, onOpenBrowser, onDraftReply }) {
  return (
    <ReportView
      auth={auth}
      onLockout={onLockout}
      active="life"
      title="// life"
      apiPath="/api/life"
      emptyHint="friends, plans, peyton & jude — pull data on sweep, then generate"
      onOpenChat={onOpenChat}
      onOpenSweep={onOpenSweep}
      onOpenTasks={onOpenTasks}
      onOpenWork={onOpenWork}
      onOpenLife={() => {}}
      onOpenTexts={onOpenTexts}
      onOpenBrowser={onOpenBrowser}
      onDraftReply={onDraftReply}
    />
  );
}
