# Three-day hackathon guide

Teams receive a working Agent platform and build exactly one middleware track.
Rebuilding the UI, control plane, local Runtime, or ECS setup is out of scope.

## Provided baseline

- Browser Agent CRUD and Playground
- Persistent workspaces and Codex sessions
- One-line Docker, Colima, or Podman local Runtime
- Volcengine Ark model connection
- Optional Volcengine ECS deployment

Local execution is the default judging path. Cloud deployment is optional.

## Choose one track

### Glass Box: trace and audit

Make a Run diagnosable.

Required demo:

- Show correlated Run and step events in a timeline or tree.
- Include status, duration, errors, and available model usage.
- Redact secrets.
- Run one successful task and identify the failing step in one failed task.

### Bouncer: identity and authorization

Separate the human user from the Agent acting for that user.

Required demo:

- Create User A, User B, and an Agent principal owned by User A.
- Allow the Agent to read User A's mock resource.
- Deny access to User B's resource in the backend.
- Record the human, Agent, action, resource, and decision.

A login screen without server-side authorization does not qualify.

### Kill Switch: safety and sandboxing

Contain one explicit dangerous action.

Required demo:

- Add a threat-specific policy or a stronger sandbox boundary.
- Block or terminate a malicious Run.
- Keep the protected asset unchanged and show cleanup.
- Run a safe task after containment.

The Starter Kit's default CPU, memory, PID, and capability limits do not count
as the new control.

## Three-day plan

| Day | Goal |
| --- | --- |
| 1 | Start the POC, select one story, define the middleware contract, and complete the backend path. |
| 2 | Finish enforcement or instrumentation, add the minimum UI, and implement positive and negative cases. |
| 3 | Add tests, handle failures, finish the diagram, and rehearse the demo. |

## Deliverables

Only three deliverables are required:

1. **Three-minute live demo:** show a real Agent Run and the middleware result.
2. **One-page architecture diagram:** show the middleware and trust boundary.
3. **Code repository:** include setup, tests, selected track, and limitations.

## Evaluation

| Category | Weight |
| --- | ---: |
| End-to-end middleware behavior | 40% |
| Technical design and integration | 25% |
| Verification and robustness | 20% |
| Demo and reproducibility | 15% |

## Acceptance checklist

- [ ] The README names one selected track.
- [ ] A reviewer can run the project from the documented command.
- [ ] Middleware executes in the backend or Runtime path, not only in the UI.
- [ ] The demo includes a positive and a failure, denial, or malicious case.
- [ ] Automated evidence covers the core event or policy decision.
- [ ] No secret appears in source, logs, traces, screenshots, or the browser.
