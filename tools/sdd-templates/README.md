# SDD templates

Templates for the SDD (SW Development Documents) of a project. For the process and the role of each document, see [workflow.md](workflow.md).

## Use

Copy the files of `templates/` into `[project]/sdd/`. Put each ADR into `[project]/sdd/adr/ADR-[yyyymmdd]-[topic].md` ([ADR.md](templates/ADR.md)). Select the requirement format of SRS, as [workflow.md](workflow.md) says.

## Templates

- [PRD.md](templates/PRD.md) — product requirements: what and why
- [SRS.md](templates/SRS.md) — required behaviour of the system (EARS or structured) and the user interface
- [QAS.md](templates/QAS.md) — quality attribute scenarios
- [DESIGN.md](templates/DESIGN.md) — architecture (C4 levels 1 to 3), interfaces, data, deployment
- [ADR.md](templates/ADR.md) — one architecture decision and its reasons
- [ADL.md](templates/ADL.md) — log of the design decisions
