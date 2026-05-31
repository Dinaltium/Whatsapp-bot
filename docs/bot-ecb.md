# ECB — EmbedClub Hardware Bot

## What is ECB?

ECB is Bot 1 in the system. It is the assistant for EmbedClub, a hardware and embedded systems community. ECB is currently in active development and provides basic informational responses.

## Current Status

ECB is a functional stub. It can list projects, events, and deadlines from the database but does not use AI/Groq for responses. All responses are static.

## Planned Features

- Hardware project showcases and documentation
- Embedded systems learning resources
- Component libraries and datasheets
- Upcoming workshop and demo session announcements
- Project submission and demo scheduling

## Commands

| Command | Description |
|---------|-------------|
| `!ping` | Check bot response |
| `!hello` | Greeting |
| `!help` | Show available commands |
| `!projects` | List ECB projects grouped by status |
| `!events` | List upcoming ECB events |
| `!deadlines` | List upcoming project deadlines |

## Database Tables

ECB stores data in three tables:
- `ecb_projects` — Projects with status (planned/in_progress/completed), members, demo date, repo URL
- `ecb_events` — Events with title, date, description, registration link
- `ecb_deadlines` — Deadlines with notify_days_before for upcoming alerts

## Notes

- ECB makes **zero AI/Groq calls** — all responses are deterministic
- The catch-all response redirects users to `!help`
