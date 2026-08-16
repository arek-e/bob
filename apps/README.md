# Applications

The `apps` directory contains Bob's primary portable runtime processes and browser interface.

| App       | Responsibility                                                 | Primary implementation                    |
| --------- | -------------------------------------------------------------- | ----------------------------------------- |
| `core`    | Serves owner routes, builds Context packs, and owns workflows. | Node, PostgreSQL, BullMQ, and filesystem. |
| `agent`   | Runs the bounded model and Tool loop.                          | Node and OpenBao credentials.             |
| `channel` | Receives channel events and delivers replies.                  | Node, BullMQ, and Sendblue.               |
| `ui`      | Provides setup, settings, review, and recovery.                | Browser application.                      |

The root Compose profile runs these production images. It does not replace them with fixtures.

An application needs a process, browser, credential, or runtime isolation Seam. Libraries,
provider Adapters, and test Implementations do not belong in this directory.
