# Bob runtime

This stack runs one Bob instance through responsibility-based systems:

- `core` is the Core Runtime. It serves the API and UI. It runs core workflows.
- `agent` is the Agent Runtime. It runs the bounded model and tool loop.
- `channel` is the Channel Runtime. It receives events and sends replies.
- `application-storage` is Application Storage. It stores durable application records.
- `job-queue` is the Job Queue. It publishes work and tracks attempts.
- `object-storage-data` is Object Storage. It stores private files on the local volume.
- The Run Coordinator serializes owner runs and schedules delayed wakes.
- The Scheduler runs periodic maintenance work.

The service names describe system roles. Provider names occur only in the setup details:

| System              | Compose provider       | Configuration detail                                       |
| ------------------- | ---------------------- | ---------------------------------------------------------- |
| Application Storage | PostgreSQL             | `APPLICATION_STORAGE_URL` points to `application-storage`. |
| Job Queue           | BullMQ over Redis      | `JOB_QUEUE_URL` points to `job-queue`.                     |
| Object Storage      | Local filesystem       | `OBJECT_STORAGE_DIRECTORY` points to the mounted volume.   |
| Run Coordinator     | Delayed Job Queue jobs | The Core Runtime owns the coordination policy.             |
| Scheduler           | Node interval          | The Core Runtime starts the interval.                      |

Cloudflare uses different Adapters for the same systems. Do not run two provider Adapters as
authorities for the same Bob instance.

Set each required variable in `compose.yaml`. Then start the stack:

```sh
docker compose --env-file /path/to/bob.env -f infra/compose/compose.yaml up --detach --build --wait
```

Run the local proof with deterministic model and channel Adapters:

```sh
pnpm compose:check
pnpm compose:smoke
```

The smoke command uses a new project. It checks Core Runtime health, the UI, Application Storage,
the Job Queue, Agent Runtime execution, Object Storage, and Channel Runtime delivery. It stops the
test containers when the check ends.
