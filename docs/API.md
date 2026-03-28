# REST API Reference

All endpoints return JSON. CORS enabled on all routes.

## Read endpoints

| Method | Path                           | Description                                             |
| ------ | ------------------------------ | ------------------------------------------------------- |
| GET    | `/health`                      | Server status, version, uptime, agent count             |
| GET    | `/api/agents`                  | List online agents                                      |
| GET    | `/api/agents/:id`              | Get agent by ID or name                                 |
| GET    | `/api/agents/:id/heartbeat`    | Agent heartbeat status (age, status, status_text)       |
| GET    | `/api/channels`                | List active channels                                    |
| GET    | `/api/channels/:name`          | Channel details with members                            |
| GET    | `/api/channels/:name/members`  | Channel member list                                     |
| GET    | `/api/channels/:name/messages` | Channel messages (`?limit=50`)                          |
| GET    | `/api/messages`                | List messages (`?limit=50&from=&to=&offset=`)           |
| GET    | `/api/messages/:id/thread`     | Get full thread                                         |
| GET    | `/api/search`                  | Full-text search (`?q=keyword&limit=20&channel=&from=`) |
| GET    | `/api/state`                   | List state entries (`?namespace=&prefix=`)              |
| GET    | `/api/state/:namespace/:key`   | Get specific state entry                                |
| GET    | `/api/overview`                | Full snapshot (agents, channels, messages, state)       |
| GET    | `/api/export`                  | Full database export as JSON                            |

## Write endpoints

| Method | Path                         | Body                                                      | Description                            |
| ------ | ---------------------------- | --------------------------------------------------------- | -------------------------------------- |
| POST   | `/api/messages`              | `{from, to?, channel?, content, importance?, thread_id?}` | Send a message                         |
| POST   | `/api/state/:namespace/:key` | `{value, updated_by}`                                     | Set state entry                        |
| DELETE | `/api/messages`              | —                                                         | Purge all messages                     |
| DELETE | `/api/messages`              | `{before?, from?, channel?}`                              | Delete messages by filter              |
| DELETE | `/api/messages/:id`          | `{agent_id}`                                              | Delete a message (sender only)         |
| DELETE | `/api/state/:namespace/:key` | —                                                         | Delete state entry                     |
| DELETE | `/api/agents/offline`        | —                                                         | Purge offline agents                   |
| POST   | `/api/cleanup`               | —                                                         | Trigger manual cleanup                 |
| POST   | `/api/cleanup/stale`         | —                                                         | Clean up stale agents and old messages |
| POST   | `/api/cleanup/full`          | —                                                         | Full database cleanup                  |

## Authentication

The REST API is **unauthenticated**. It is designed for localhost use between trusted agents. The only protection on write endpoints is:

- `POST /api/messages` requires the `from` agent to be online (prevents impersonation of offline agents)
- `DELETE /api/messages/:id` requires the `agent_id` to match the message sender

## Error responses

```json
{
  "error": "Description of the error",
  "code": "VALIDATION_ERROR"
}
```

| Status | Code               | Meaning                                     |
| ------ | ------------------ | ------------------------------------------- |
| 400    | —                  | Bad request (missing params, invalid input) |
| 404    | `NOT_FOUND`        | Entity not found                            |
| 409    | `CONFLICT`         | Conflict (e.g. duplicate agent name)        |
| 422    | `VALIDATION_ERROR` | Input validation failure                    |
| 429    | `RATE_LIMITED`     | Rate limit exceeded                         |
| 500    | —                  | Internal server error                       |
