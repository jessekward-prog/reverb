import React from 'react';
import ReportView from './ReportView.jsx';

// The championed tab: one list of everything to do, work and life merged and
// ranked (priority > vip > money > chased > age) by /api/tasks. It's the same
// read-only report surface — checkboxes, the chase nudge, get-context and
// add-to-cal — pointed at the combined endpoint, so there's one place to act
// rather than two reports to reconcile.
export default function TasksView({ auth, onLockout, onOpenChat, onOpenSweep, onOpenWork, onOpenLife, onOpenTexts, onOpenBrowser, onDraftReply }) {
  return (
    <ReportView
      auth={auth}
      onLockout={onLockout}
      active="tasks"
      title="// to-do"
      apiPath="/api/tasks"
      emptyHint="your whole list, ranked — pull data on sweep, then generate"
      onOpenChat={onOpenChat}
      onOpenSweep={onOpenSweep}
      onOpenTasks={() => {}}
      onOpenWork={onOpenWork}
      onOpenLife={onOpenLife}
      onOpenTexts={onOpenTexts}
      onOpenBrowser={onOpenBrowser}
      onDraftReply={onDraftReply}
    />
  );
}
