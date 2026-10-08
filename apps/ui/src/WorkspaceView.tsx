import { string, type Snapshot, type RecordData } from './api.js';
import { Empty, Status, JsonDetails, RecordRow, type Action, type Run } from './components.js';
export function WorkspaceView({
  state,
  room,
  run: _run,
  openAction,
}: {
  state: Snapshot;
  room?: RecordData;
  run: Run;
  openAction: (a: Action) => void;
}) {
  const id = string(room ?? {}, 'id'),
    tasks = state.tasks.filter((t) => !id || t.roomId === id),
    seats = state.seats.filter((s) => s.roomId === id && s.mode === 'managed');
  const action = (title: string, command: string, args: RecordData, confirm?: string) =>
    openAction({ title, command, args, confirm });
  return (
    <div className="workspace-view">
      <div className="section-heading">
        <div>
          <h1>{room ? 'Coding workspace' : 'Workspace'}</h1>
          <p>
            Independent clones, exact content and fresh checks. Execution is trusted local with
            advisory scope limits.
          </p>
        </div>
      </div>
      <div className="workspace-section">
        <div className="section-heading">
          <h2>Repositories and check profiles</h2>
          <div className="row-actions">
            <button
              onClick={() =>
                openAction({
                  title: 'Register local repository',
                  command: 'repo_register',
                  description:
                    'Select a Git repository root with a committed foundation. Dirty owner files remain untouched. Private environment files are not copied.',
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
              onClick={() =>
                openAction({
                  title: 'Approve local check profile',
                  command: 'profile_register',
                  description:
                    'These commands execute local repository code. Review every argv entry. There is no OS sandbox guarantee. Hosted credentials and shared service profiles are disabled.',
                  fields: [
                    { key: 'name', label: 'Profile name', required: true },
                    {
                      key: 'scopePaths',
                      label: 'Source scopes, one relative path per line',
                      type: 'paths',
                      required: true,
                    },
                    {
                      key: 'commands',
                      label: 'Check commands (JSON argv arrays)',
                      type: 'json',
                      required: true,
                      value: '[{"executable":"node","args":["--test"],"timeoutMs":120000}]',
                    },
                    {
                      key: 'generatedPaths',
                      label: 'Permitted generated directories, one per line',
                      type: 'paths',
                      value: 'node_modules\ndist\nbuild',
                    },
                  ],
                  confirm:
                    'Approve this exact check profile for 24 hours. These commands may run on submitted or combined candidate content.',
                })
              }
            >
              Approve check profile
            </button>
          </div>
        </div>
        {state.repos.map((r) => (
          <RecordRow key={string(r, 'id')} item={r}>
            <p>
              <code>{string(r, 'path')}</code>
            </p>
            <p className="small">
              Foundation <code>{string(r, 'foundation')}</code>
            </p>
          </RecordRow>
        ))}
        {state.profiles.map((p) => (
          <RecordRow key={string(p, 'id')} item={p}>
            <p>{string(p, 'containment')}</p>
          </RecordRow>
        ))}
      </div>
      <div className="workspace-section">
        <div className="section-heading">
          <h2>Tasks</h2>
          <button
            disabled={!id || !state.repos.length || !state.profiles.length}
            onClick={() =>
              openAction({
                title: 'Plan task graph',
                command: 'task_plan',
                args: { roomId: id },
                fields: [
                  {
                    key: 'repoId',
                    label: 'Repository',
                    type: 'select',
                    required: true,
                    options: state.repos.map((r) => ({
                      value: string(r, 'id'),
                      label: string(r, 'name'),
                    })),
                  },
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
        {!tasks.length && (
          <Empty title="No coding tasks yet">
            Register a repository and approve a check profile, then plan tasks with source scopes
            and prerequisites.
          </Empty>
        )}
        {tasks.map((t) => (
          <RecordRow key={string(t, 'roomId') + string(t, 'id')} item={t}>
            <p>{string(t, 'acceptance')}</p>
            <div className="row-actions">
              <button
                disabled={!['ready', 'rework'].includes(string(t, 'status'))}
                onClick={() =>
                  openAction({
                    title: 'Claim isolated coding attempt',
                    command: 'task_claim',
                    args: { roomId: t.roomId, taskId: t.id },
                    description:
                      'Reserve source scopes and provision a separate clone. Approval to launch the agent is a separate step.',
                    fields: [
                      {
                        key: 'seatId',
                        label: 'Managed worker',
                        type: 'select',
                        required: true,
                        options: seats.map((s) => ({
                          value: string(s, 'id'),
                          label: string(s, 'name'),
                        })),
                      },
                    ],
                  })
                }
              >
                Claim attempt
              </button>
            </div>
          </RecordRow>
        ))}
      </div>
      <div className="workspace-section">
        <h2>Coding attempts</h2>
        {state.attempts
          .filter((at) => !id || at.roomId === id)
          .map((at) => (
            <RecordRow key={string(at, 'id')} item={at} title={'Attempt ' + string(at, 'taskId')}>
              <p>
                <code>{string(at, 'path')}</code>
              </p>
              <p className="small">
                Lease expires {new Date(Number(at.leaseExpiresAt)).toLocaleTimeString('en-AU')}.
                Uncertain work stays quarantined.
              </p>
              <div className="row-actions">
                <button
                  disabled={at.status !== 'ready'}
                  onClick={() =>
                    openAction({
                      title: 'Launch assigned coding turn',
                      command: 'turn_request',
                      args: { roomId: at.roomId, seatId: at.seatId, attemptId: at.id },
                      fields: [
                        {
                          key: 'prompt',
                          label: 'Coding instructions',
                          type: 'textarea',
                          required: true,
                        },
                      ],
                      description:
                        'The new managed session is bound to this clone and generation. Review its execution request in Approvals.',
                    })
                  }
                >
                  Request coding turn
                </button>
                <button
                  disabled={!['ready', 'running'].includes(string(at, 'status'))}
                  onClick={() =>
                    action('Renew current lease', 'task_heartbeat', {
                      roomId: at.roomId,
                      attemptId: at.id,
                    })
                  }
                >
                  Renew lease
                </button>
                <button
                  disabled={!['ready', 'completed'].includes(string(at, 'status'))}
                  onClick={() =>
                    action(
                      'Submit exact changes',
                      'task_submit',
                      { roomId: at.roomId, attemptId: at.id },
                      'Capture current bytes, modes and deletions. A live or uncertain worker cannot publish a submission.',
                    )
                  }
                >
                  Submit content
                </button>
              </div>
            </RecordRow>
          ))}
      </div>
      <div className="workspace-section">
        <h2>Submissions and evidence</h2>
        {state.manifests
          .filter((m) => !id || m.roomId === id)
          .map((m) => (
            <RecordRow key={string(m, 'id')} item={m} title={'Submission ' + string(m, 'taskId')}>
              <p className="small">
                Result <code>{string(m, 'resultDigest')}</code>
              </p>
              <details>
                <summary>Inspect changes</summary>
                <pre>{string(m, 'diff')}</pre>
              </details>
              <div className="row-actions">
                <button
                  onClick={() =>
                    action(
                      'Run independent checks',
                      'verification_request',
                      { roomId: m.roomId, manifestId: m.id },
                      'Run the approved check profile against these exact bytes in a fresh clone and resource environment.',
                    )
                  }
                >
                  Run checks
                </button>
                <button
                  onClick={() =>
                    openAction({
                      title: 'Review submission',
                      command: 'review_submit',
                      args: { roomId: m.roomId, manifestId: m.id },
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
                        {
                          key: 'reason',
                          label: 'Review evidence and remaining risks',
                          type: 'textarea',
                          required: true,
                        },
                      ],
                    })
                  }
                >
                  Review content
                </button>
              </div>
              {state.verifications
                .filter((v) => v.manifestId === m.id)
                .map((v) => (
                  <div className="evidence" key={string(v, 'id')}>
                    <Status value={string(v, 'status')} />
                    <span>Fresh verification</span>
                    <JsonDetails value={v} title="Checks, exact content and environment" />
                  </div>
                ))}
            </RecordRow>
          ))}
      </div>
      <div className="workspace-section">
        <div className="section-heading">
          <h2>Combined candidates</h2>
          <button
            disabled={!id}
            onClick={() =>
              openAction({
                title: 'Prepare combined candidate',
                command: 'integration_prepare',
                args: { roomId: id },
                fields: [
                  {
                    key: 'repoId',
                    label: 'Repository',
                    type: 'select',
                    required: true,
                    options: state.repos.map((r) => ({
                      value: string(r, 'id'),
                      label: string(r, 'name'),
                    })),
                  },
                  {
                    key: 'manifestIds',
                    label: 'Accepted submission IDs in dependency order, one per line',
                    type: 'paths',
                    required: true,
                  },
                  {
                    key: 'profileId',
                    label: 'Full integration check profile',
                    type: 'select',
                    required: true,
                    options: state.profiles.map((p) => ({
                      value: string(p, 'id'),
                      label: string(p, 'name'),
                    })),
                  },
                ],
                confirm:
                  'Compose accepted patches once in order, then run the full profile in a fresh verification environment. This creates no commit.',
              })
            }
          >
            Prepare candidate
          </button>
        </div>
        {state.candidates
          .filter((c) => !id || c.roomId === id)
          .map((c) => (
            <RecordRow key={string(c, 'id')} item={c}>
              <div className="row-actions">
                <button
                  disabled={c.status !== 'verified'}
                  onClick={() =>
                    openAction({
                      title: 'Accept final candidate',
                      command: 'candidate_review',
                      args: { roomId: c.roomId, candidateId: c.id },
                      fields: [
                        {
                          key: 'reason',
                          label: 'Final combined review',
                          type: 'textarea',
                          required: true,
                        },
                      ],
                      confirm:
                        'Review final digest ' +
                        string(c, 'resultDigest') +
                        ' and combined check evidence. This approves the candidate, not an automatic apply.',
                    })
                  }
                >
                  Review final candidate
                </button>
                <button
                  disabled={c.status !== 'accepted'}
                  onClick={() =>
                    action(
                      'Apply verified candidate',
                      'candidate_apply',
                      { roomId: c.roomId, candidateId: c.id },
                      'Apply digest ' +
                        string(c, 'resultDigest') +
                        ' to the original checkout only if its content/base still matches. Dirty or changed target files block application. No commit, push or deployment is performed.',
                    )
                  }
                >
                  Apply to checkout
                </button>
              </div>
              {state.verifications
                .filter((v) => v.candidateId === c.id)
                .map((v) => (
                  <JsonDetails
                    key={string(v, 'id')}
                    value={v}
                    title={'Combined checks: ' + string(v, 'status')}
                  />
                ))}
            </RecordRow>
          ))}
      </div>
      <div className="workspace-section">
        <h2>Resource lifetimes</h2>
        <p>
          Unknown or expired execution stays quarantined. Interactive previews and hosted service
          profiles are disabled. Approved local-kv fixtures use separate runtime-owned endpoints and
          credentials.
        </p>
        {state.resources
          .filter((r) => !id || r.roomId === id)
          .map((r) => (
            <RecordRow key={string(r, 'id')} item={r} />
          ))}
      </div>
    </div>
  );
}
