# DKB — DK24 Developer Community Assistant

## What is DKB?

DKB is Bot 2 in the system. It is the assistant for DK24 (Developer Kommunity 24), Mangalore's unified tech community network connecting college clubs and student developers.

## Scope

DKB has access to a live database of:
- Member clubs/communities across colleges in Mangalore
- Tech events, hackathons, and meetups
- A mentor directory of industry professionals
- Community structure and DK24 organizational info

## Commands

| Command | Description |
|---------|-------------|
| `!ping` | Check bot response |
| `!hello` | Check availability |
| `!reset` | Reset conversation context |
| `!clubs` | List all member communities |
| `!club <name>` | Spotlight card for a specific club |
| `!events [month-year]` | List events (e.g. `!events may-2026`) |
| `!event <name>` | Details and registration for a specific event |
| `!mentors [page]` | List mentors alphabetically (10 per page) |
| `!mentor -id <id>` | View a specific mentor by ID |
| `!mentor -f <query>` | Filter mentors by name or keyword |
| `!next` | Next page of the active mentor query |
| `!page <n>` | Jump to a specific page of the active query |
| `!addmentor` | Add a mentor (authorized users only) |
| `!editmentor` | Edit a mentor field (authorized users only) |
| `!delmentor` | Delete a mentor (authorized users only) |
| `!<question>` | Ask DKB anything about the community |

## Mentor System

The mentor directory stores:
- Name, expertise, organization
- LinkedIn, Instagram, GitHub, email
- Phone number (with country code)

Mentor management requires the `mentor` RBAC role or admin privileges.

## RBAC Roles

DKB supports role-based access control:
- `mentor` role: can add, edit, delete mentors
- Roles are assigned by admins via `!manage -r <role> -u <jid>`
- Bulk role assignment: `!manage -r <role> -g all -id <group_db_id>`

## Rate Limits

Same as PARAG — 5 AI requests/minute, 100/hour per group, 2000/day global.
