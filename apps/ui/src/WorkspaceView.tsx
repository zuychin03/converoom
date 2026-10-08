import { useState, type ReactNode } from 'react';
import { list, string, type RecordData, type Snapshot } from './api.js';
import {
  Countdown,
  Elapsed,
  Empty,
  ErrorNotice,
  JsonDetails,
  SeatCode,
  Status,
  useNow,
  type Action,
  type Run,
} from './components.js';
import { STAGES, acceptedOrder, num, shortId, taskProgress, type Kind } from './model.js';

export function WorkspaceView({
  state,
  room,
  run,
  openAction,
  onPickRoom,
}: {
  state: Snapshot;
  room?: RecordData;
  run: Run;
  openAction: (action: Action) => void;
  onPickRoom: (id: string) => void;
}) {
  const now = useNow(5000);
  const roomId = room ? string(room, 'id') : '';
  const tasks = state.tasks.filter((t) => t.roomId === roomId);
  const workers = state.seats.filter((s) => s.roomId === roomId && s.mode === 'managed' && s.status !== 'left');
  const candidates = state.candidates.filter((c) => c.roomId === roomId);
  const repoOptions = state.repos.map((r) => ({ value: string(r, 'id'), label: string(r, 'name') }));
  const profileOptions = state.profiles.map((p) => ({ value: string(p, 'id'), label: string(p, 'name') }));
  return (
    <div className="work">
      <div className="page-head">
        <h1>Work</h1>
        <p>
          {room ? (
            <>
              Coding pipeline for <strong>{string(room, 'title')}</strong>. Every attempt gets its own
              clone, every submission is exact content, and every check runs fresh. Execution is trusted
              local; source scopes are advisory, not a sandbox.
            </>
          ) : (
            'Choose a room to see its coding pipeline.'
          )}
        </p>
      </div>
      {!room && (
        <ul className="room-picker">
          {state.rooms.map((r) => (
            <li key={string(r, 'id')}>
              <button type="button" className="room-item" onClick={() => onPickRoom(string(r, 'id'))}>
                <span className="room-item-code num">{shortId(string(r, 'id'))}</span>
                <span className="room-item-title">{string(r, 'title')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {room && (
        <>
          <section className="work-section" aria-labelledby="tasks-title">
            <div className="section-head">
              <h2 id="tasks-title" className="section-label">
                Tasks
              </h2>
              <button
                type="button"
                className="button small"
                disabled={!state.repos.length || !state.profiles.length || room.status !== 'open'}
                onClick={() =>
                  openAction({
                    title: 'Plan task graph',
                    command: 'task_plan',
                    args: { roomId },
                    fields: [
                      { key: 'repoId', label: 'Repository', type: 'select', required: true, options: repoOptions },
                      {
                        key: 'tasks',
                        label: 'Tasks with IDs, scopePaths, acceptance, dependsOn and profileId',
                        type: 'json',
                        required: true,
                        value: JSON.stringify(
                          [
                            {
                              id: 'task-1',
                              title: 'Describe the change',
                              scopePaths: ['src'],
                              acceptance: 'Relevant checks pass',
                              dependsOn: [],
                              profileId: string(state.profiles[0] ?? {}, 'id'),
                            },
                          ],
                          null,
                          2,
                        ),
                      },
                    ],
                  })
                }
              >
                Plan tasks
              </button>
            </div>
            {tasks.length === 0 ? (
              <Empty title="No coding tasks yet">
                Register a repository and approve a check profile below, then plan tasks with source
                scopes and prerequisites.
              </Empty>
            ) : (
              <ol className="pipeline">
                {tasks.map((task) => (
                  <TaskRow
                    key={string(task, 'id')}
                    task={task}
                    state={state}
                    now={now}
                    workers={workers}
                    roomOpen={room.status === 'open'}
                    run={run}
                    openAction={openAction}
                  />
                ))}
              </ol>
            )}
          </section>
          <section className="work-section" aria-labelledby="candidates-title">
            <div className="section-head">
              <h2 id="candidates-title" className="section-label">
                Combined candidates
              </h2>
              <button
                type="button"
                className="button small"
                disabled={!acceptedOrder(state, roomId).length || room.status !== 'open'}
                onClick={() =>
                  openAction({
                    title: 'Prepare combined candidate',
                    command: 'integration_prepare',
                    args: { roomId },
                    fields: [
                      {
                        key: 'repoId',
                        label: 'Repository',
                        type: 'select',
                        required: true,
                        options: repoOptions,
                        value: string(tasks.find((t) => t.status === 'accepted') ?? {}, 'repoId'),
                      },
                      {
                        key: 'manifestIds',
                        label: 'Accepted submission IDs in dependency order, one per line',
                        type: 'paths',
                        required: true,
                        value: acceptedOrder(state, roomId).join('\n'),
                      },
                      { key: 'profileId', label: 'Full integration check profile', type: 'select', required: true, options: profileOptions },
                    ],
                    confirm:
                      'Compose accepted submissions once, in order, then run the full profile in a fresh verification environment. This creates no commit.',
                  })
                }
              >
                Prepare candidate
              </button>
            </div>
            {candidates.length === 0 ? (
              <p className="rail-note">
                Accepted submissions combine into one candidate here, checked fresh before you apply it.
              </p>
            ) : (
              <ul className="candidates">
                {candidates.map((c) => (
                  <CandidateRow key={string(c, 'id')} candidate={c} state={state} openAction={openAction} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <section className="work-section" aria-labelledby="sources-title">
        <div className="section-head">
          <h2 id="sources-title" className="section-label">
            Repositories and check profiles
          </h2>
          <div className="row-actions">
            <button
              type="button"
              className="button small"
              onClick={() =>
                openAction({
                  title: 'Register local repository',
                  command: 'repo_register',
                  description:
                    'Choose a Git repository root with a committed foundation. Dirty files in your checkout stay untouched. Private environment files are not copied.',
                  fields: [
                    { key: 'name', label: 'Repository name', required: true },
                    { key: 'path', label: 'Absolute Git root', required: true },
                  ],
                })
              }
            >
              Register repository
            </button>
            <button
              type="button"
              className="button small"
              onClick={() =>
                openAction({
                  title: 'Approve local check profile',
                  command: 'profile_register',
                  description:
                    'These commands run local repository code. Review every argument. There is no OS sandbox. Hosted credentials and shared services are disabled.',
                  fields: [
                    { key: 'name', label: 'Profile name', required: true },
                    { key: 'scopePaths', label: 'Source scopes, one relative path per line', type: 'paths', required: true },
                    {
                      key: 'commands',
                      label: 'Check commands (JSON argv arrays)',
                      type: 'json',
                      required: true,
                      value: '[{"executable":"node","args":["--test"],"timeoutMs":120000}]',
                    },
                    { key: 'generatedPaths', label: 'Permitted generated directories, one per line', type: 'paths', value: 'node_modules\ndist\nbuild' },
                  ],
                  confirm: 'Approve this exact check profile for 24 hours. These commands may run on submitted or combined content.',
                })
              }
            >
              Approve check profile
            </button>
          </div>
        </div>
        {state.repos.length === 0 && state.profiles.length === 0 && (
          <p className="rail-note">No repositories or profiles yet. Both are needed before planning tasks.</p>
        )}
        <ul className="sources">
          {state.repos.map((repo) => (
            <li key={string(repo, 'id')} className="source">
              <span className="source-kind">Repository</span>
              <span className="source-name">{string(repo, 'name')}</span>
              <code className="source-path">{string(repo, 'path')}</code>
              <span className="source-meta num">foundation {string(repo, 'foundation').slice(0, 12)}</span>
            </li>
          ))}
          {state.profiles.map((profile) => {
            const expires = num(profile, 'expiresAt') ?? 0;
            return (
              <li key={string(profile, 'id')} className="source">
                <span className="source-kind">Profile</span>
                <span className="source-name">{string(profile, 'name')}</span>
                <code className="source-path">{list(profile, 'scopePaths').join(', ')}</code>
                <span className="source-meta">
                  {expires > now ? (
                    <>
                      expires in <Countdown until={expires} urgentBelow={3600000} />
                    </>
                  ) : (
                    <Status kind="closed">Expired</Status>
                  )}{' '}
                  · {string(profile, 'containment')}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
      <details className="work-section resources">
        <summary>Resource lifetimes ({state.resources.filter((r) => !roomId || r.roomId === roomId).length})</summary>
        <p className="rail-note">
          Unknown or expired execution stays quarantined until inspected. Interactive previews and hosted
          service profiles are disabled.
        </p>
        <ul className="sources">
          {state.resources
            .filter((r) => !roomId || r.roomId === roomId)
            .map((r) => (
              <li key={string(r, 'id')} className="source">
                <span className="source-kind num">{shortId(string(r, 'id'), 8)}</span>
                <Status kind={r.status === 'quarantined' ? 'warn' : r.status === 'active' ? 'live' : 'idle'}>
                  {string(r, 'status')}
                </Status>
                <span className="source-meta">{string(r, 'containment')}</span>
              </li>
            ))}
        </ul>
      </details>
    </div>
  );
}

function TaskRow({
  task,
  state,
  now,
  workers,
  roomOpen,
  run,
  openAction,
}: {
  task: RecordData;
  state: Snapshot;
  now: number;
  workers: RecordData[];
  roomOpen: boolean;
  run: Run;
  openAction: (action: Action) => void;
}) {
  const [error, setError] = useState('');
  const progress = taskProgress(task, state);
  const status = string(task, 'status');
  const attempt = progress.attempt;
  const attemptStatus = attempt ? string(attempt, 'status') : '';
  const lease = attempt ? (num(attempt, 'leaseExpiresAt') ?? 0) : 0;
  const leaseLive = lease > now;
  const roomId = string(task, 'roomId');
  let phase: [Kind, ReactNode] = ['idle', 'Planned'];
  const actions: ReactNode[] = [];
  const claim = () =>
    openAction({
      title: 'Claim isolated coding attempt',
      command: 'task_claim',
      args: { roomId, taskId: task.id },
      description:
        'Reserve source scopes and provision a separate clone. Once ready, you have up to an hour to authorise the coding turn. Active workers use a renewable 60-second lease.',
      fields: [
        {
          key: 'seatId',
          label: 'Managed worker',
          type: 'select',
          required: true,
          options: workers.map((s) => ({ value: string(s, 'id'), label: string(s, 'name') })),
        },
      ],
    });
  if (['ready', 'rework', 'stale'].includes(status)) {
    phase =
      status === 'ready' ? ['idle', 'Ready to claim'] : status === 'rework' ? ['warn', 'Rework requested'] : ['warn', 'Prerequisite changed'];
    actions.push(
      <button key="claim" type="button" className="button small" disabled={!roomOpen || !workers.length} onClick={claim}>
        Claim attempt
      </button>,
    );
  } else if (status === 'provisioning') phase = ['live', 'Provisioning clone'];
  else if (status === 'claimed' && attempt) {
    if (attemptStatus === 'ready') {
      phase = ['idle', 'Clone ready'];
      actions.push(
        <button
          key="turn"
          type="button"
          className="button small primary"
          disabled={!roomOpen || !leaseLive}
          onClick={() =>
            openAction({
              title: 'Launch assigned coding turn',
              command: 'turn_request',
              args: { roomId, seatId: attempt.seatId, attemptId: attempt.id },
              description: 'The new managed session is bound to this clone and generation. Review and grant the request before the approval window ends.',
              fields: [{ key: 'prompt', label: 'Coding instructions', type: 'textarea', required: true }],
            })
          }
        >
          Request coding turn
        </button>,
        <button
          key="renew"
          type="button"
          className="button small"
          disabled={!leaseLive}
          onClick={() => {
            setError('');
            run('task_heartbeat', { roomId, attemptId: attempt.id }).catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : 'Lease not renewed.'),
            );
          }}
        >
          Renew lease
        </button>,
      );
    } else if (attemptStatus === 'running') {
      const turn = state.turns.find((t) => t.attemptId === attempt.id && t.status === 'running');
      const since = turn ? num(turn, 'startedAt') : undefined;
      phase = ['live', since ? <>Coding <Elapsed since={since} /></> : 'Coding'];
    } else if (attemptStatus === 'completed') {
      phase = ['needs', 'Submit before the lease ends'];
      actions.push(
        <button
          key="submit"
          type="button"
          className="button small primary"
          disabled={!leaseLive}
          onClick={() =>
            openAction({
              title: 'Submit exact changes',
              command: 'task_submit',
              args: { roomId, attemptId: attempt.id },
              label: 'Submit content',
              confirm: 'Capture the current bytes, modes and deletions. A live or uncertain worker cannot publish a submission.',
            })
          }
        >
          Submit content
        </button>,
      );
    } else if (['quarantined', 'uncertain'].includes(attemptStatus))
      phase = ['warn', 'Quarantined · inspect the clone'];
  } else if (status === 'claimed') phase = ['idle', 'Claimed'];
  else if (status === 'submitted' && progress.manifest) {
    const latest = progress.verifications.at(-1);
    if (progress.passing) {
      phase = ['ok', 'Checks passed'];
      actions.push(
        <button
          key="review"
          type="button"
          className="button small primary"
          disabled={!roomOpen}
          onClick={() =>
            openAction({
              title: 'Review submission',
              command: 'review_submit',
              args: { roomId, manifestId: progress.manifest!.id },
              fields: [
                {
                  key: 'verdict',
                  label: 'Verdict',
                  type: 'select',
                  required: true,
                  options: [
                    { value: 'accept', label: 'Accept exact content' },
                    { value: 'reject', label: 'Request rework' },
                  ],
                },
                { key: 'reason', label: 'Review evidence and remaining risks', type: 'textarea', required: true },
              ],
            })
          }
        >
          Review
        </button>,
      );
    } else {
      phase = latest
        ? [latest.status === 'blocked' ? 'warn' : 'fail', latest.status === 'blocked' ? 'Checks blocked' : 'Checks failed']
        : ['idle', 'Awaiting checks'];
      actions.push(
        <button
          key="checks"
          type="button"
          className="button small primary"
          disabled={!roomOpen}
          onClick={() =>
            openAction({
              title: 'Run independent checks',
              command: 'verification_request',
              args: { roomId, manifestId: progress.manifest!.id },
              label: 'Run checks',
              confirm: 'Run the approved check profile against these exact bytes in a fresh clone and resource environment.',
            })
          }
        >
          {latest ? 'Run checks again' : 'Run checks'}
        </button>,
      );
    }
  } else if (status === 'accepted')
    phase = progress.candidate
      ? progress.candidate.status === 'applied'
        ? ['ok', 'Applied']
        : ['ok', 'In a candidate']
      : ['ok', 'Accepted'];
  if (attempt && (['quarantined', 'uncertain'].includes(attemptStatus) ||
    (attemptStatus === 'completed' && !leaseLive)))
    actions.push(<button key="release" type="button" className="button small" onClick={() =>
      openAction({ title: 'Inspect and release reservation', command: 'attempt_release',
        args: { roomId, attemptId: attempt.id, confirm: true }, label: 'Release reservation',
        description: `Inspect the preserved clone at ${string(attempt, 'path')}. Release retains its files and fences this generation. Active or uncertain processes must have confirmed stop before release.`,
        fields: [{ key: 'reason', label: 'Inspection and retained-work handoff', type: 'textarea', required: true }],
      })}>Inspect reservation</button>);
  const showLease = attempt && ['ready', 'completed'].includes(attemptStatus) && status === 'claimed';
  return (
    <li className="task">
      <span className="task-id num">{string(task, 'id')}</span>
      <div className="task-main">
        <h3 className="task-title">{string(task, 'title')}</h3>
        <p className="task-meta">
          <code>{list(task, 'scopePaths').join(', ')}</code>
          {list(task, 'dependsOn').length > 0 && <> · after {list(task, 'dependsOn').join(', ')}</>}
          {attempt && (
            <>
              {' '}
              · <SeatCode id={string(attempt, 'seatId')} />{' '}
              {string(state.seats.find((s) => s.id === attempt.seatId) ?? {}, 'name')}
            </>
          )}
        </p>
        <ol className="stages" aria-label={`Stage ${progress.stage + 1} of ${STAGES.length}: ${STAGES[progress.stage]}`}>
          {STAGES.map((stage, i) => (
            <li
              key={stage}
              className={i < progress.stage ? 'done' : i === progress.stage ? 'current' : ''}
              aria-current={i === progress.stage ? 'step' : undefined}
            >
              <span>{stage}</span>
            </li>
          ))}
        </ol>
      </div>
      <div className="task-next">
        <Status kind={phase[0]}>{phase[1]}</Status>
        {showLease && (
          <span className="lease">
            {leaseLive ? (
              <>
                Lease <Countdown until={lease} />
              </>
            ) : (
              'Lease expired'
            )}
          </span>
        )}
        <div className="row-actions">{actions}</div>
        {error && <ErrorNotice dismiss={() => setError('')}>{error}</ErrorNotice>}
      </div>
      {progress.manifest && (
        <details className="task-changes">
          <summary>
            Changes · result <span className="num">{string(progress.manifest, 'resultDigest').slice(0, 12)}</span>
          </summary>
          <pre>{string(progress.manifest, 'diff')}</pre>
          {progress.verifications.map((v) => (
            <JsonDetails key={string(v, 'id')} value={v} title={`Verification · ${string(v, 'status')}`} />
          ))}
        </details>
      )}
    </li>
  );
}

function CandidateRow({
  candidate,
  state,
  openAction,
}: {
  candidate: RecordData;
  state: Snapshot;
  openAction: (action: Action) => void;
}) {
  const status = string(candidate, 'status');
  const digest = string(candidate, 'resultDigest');
  const kind: Kind =
    status === 'applied' || status === 'verified' || status === 'accepted'
      ? 'ok'
      : status === 'failed'
        ? 'fail'
        : status === 'uncertain' || status === 'stale'
          ? 'warn'
          : 'idle';
  const verification = state.verifications.find((v) => v.candidateId === candidate.id);
  return (
    <li className="candidate">
      <span className="task-id num">{shortId(string(candidate, 'id'))}</span>
      <div className="task-main">
        <h3 className="task-title">
          {list(candidate, 'manifestIds').length} submissions · result <span className="num">{digest.slice(0, 12)}</span>
        </h3>
        {verification && <JsonDetails value={verification} title={`Combined checks · ${string(verification, 'status')}`} />}
      </div>
      <div className="task-next">
        <Status kind={kind}>{status}</Status>
        <div className="row-actions">
          <button
            type="button"
            className="button small"
            disabled={status !== 'verified'}
            onClick={() =>
              openAction({
                title: 'Accept final candidate',
                command: 'candidate_review',
                args: { roomId: candidate.roomId, candidateId: candidate.id },
                fields: [{ key: 'reason', label: 'Final combined review', type: 'textarea', required: true }],
                confirm: `Review final digest ${digest} and its combined check evidence. This approves the candidate; it does not apply it.`,
              })
            }
          >
            Review final candidate
          </button>
          <button
            type="button"
            className="button small primary"
            disabled={status !== 'accepted'}
            onClick={() =>
              openAction({
                title: 'Apply verified candidate',
                command: 'candidate_apply',
                args: { roomId: candidate.roomId, candidateId: candidate.id },
                label: 'Apply to checkout',
                confirm: `Apply digest ${digest} to your original checkout only if its content and base still match. A dirty or changed target blocks it. No commit, push or deployment happens.`,
              })
            }
          >
            Apply to checkout
          </button>
        </div>
      </div>
    </li>
  );
}
