# Wexy

Describe a world, watch it run on your graphics card, and film it.

This monorepo contains two applications:

| Folder | Purpose | Requirements |
| --- | --- | --- |
| `wexy backend` | Gateway, authentication, metered model calls and generation streams | Java 21, Maven wrapper, Redis 7.2, Docker for local Redis |
| `wexy frontend` | Browser studio, WebGPU runtime, verification and capture | Node >=24.12.0, Chrome or Edge with WebGPU |

See each application's README for setup. Folder names contain spaces: quote them in shell commands.

## Configuration and safety

- Real credentials come from environment variables or an operator-configured secret manager.
- `.env.example` files list configuration names and safe defaults, not credentials.
- The model API key and Firebase service-account credentials belong only in the backend.
- Local/mock profiles are for development, not public deployment. Live model calls spend credit.
- Private design documents, agent instructions, test suites, GPU harnesses and local configuration
  are intentionally excluded from Git. They remain on the development machine.
- Runtime prompt Markdown and host rules are application resources and are included. The Maven
  wrapper's public distribution properties are the only tracked `.properties` file.

## Development status

The backend provides plan, author, repair, direct and outcome endpoints with in-memory records.
The frontend includes the studio, capture tools, host contract, verification code and model clients.
Persistent records, publishing and the complete live browser path are still under development.
Source availability is not a claim that every planned product feature is complete.