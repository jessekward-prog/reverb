import React from 'react';
import ReportView from './ReportView.jsx';

export default function WorkView({ auth, onLockout, onOpenChat, onOpenSweep, onOpenTasks, onOpenLife, onOpenTexts, onOpenBrowser, onDraftReply }) {
  return (
    <ReportView
      auth={auth}
      onLockout={onLockout}
      active="work"
      title="// work"
      apiPath="/api/work"
      emptyHint="jobs, clients, bills — pull data on sweep, then generate"
      onOpenChat={onOpenChat}
      onOpenSweep={onOpenSweep}
      onOpenTasks={onOpenTasks}
      onOpenWork={() => {}}
      onOpenLife={onOpenLife}
      onOpenTexts={onOpenTexts}
      onOpenBrowser={onOpenBrowser}
      onDraftReply={onDraftReply}
    />
  );
}
