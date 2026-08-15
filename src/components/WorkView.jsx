import React from 'react';
import ReportView from './ReportView.jsx';

export default function WorkView({ auth, onLockout, onOpenChat, onOpenSweep, onOpenLife, onOpenTexts, onDraftReply }) {
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
      onOpenWork={() => {}}
      onOpenLife={onOpenLife}
      onOpenTexts={onOpenTexts}
      onDraftReply={onDraftReply}
    />
  );
}
