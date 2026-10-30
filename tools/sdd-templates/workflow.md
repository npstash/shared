# Workflow — an iterative, agile software development process

For a small team, or a team of one person. It connects the documents (PRD, SRS, quality attributes, ADR/ADL, design) with AI agent and GitHub.

## Philosophy

- Documentation is light and living, not heavy and up-front.
- Record in ADL each decision that changes the design in a non-trivial way.
- Record major architectural decisions and their reasons in ADR.
- DESIGN, PRD, SRS, QAS hold the current state. Do not log changes to PRD, SRS and QAS.
- GitHub Actions runs the tests and the QAS checks automatically.
- AI agent keeps the SDD consistent.

## Documents and their roles

These documents form a set of SDD (SW Development Documents). Put them into `[project]/sdd/`. Write the file names in uppercase. Mark content that is not known yet with **MISSING:**.

| Document | Role | When it is updated | Alias |
| :-: | :-: | :-: | :-: |
| PRD.md | What and why (product) | Outline at the start, then it grows when goals, stories etc. are added | PRD |
| SRS.md | Required behaviour of the system (EARS or structured) | When the user gives or updates a requirement | SRS |
| QAS.md | Measurable quality attributes (ADD) | When the drivers are known or updated | QAS |
| DESIGN.md | Current state of the architecture (C4 levels 1–3) | When design decisions are made | DESIGN |
| `design/[container].md` | Components of one large container | When section 5 of DESIGN gets too large, must be confirmed | DESIGN |
| `adr/ADR-[yyyymmdd]-[topic].md` | One decision and its reasons | At each important design decision, must be confirmed | ADR |
| ADL.md | Log of the design decisions, one line each | At each non-trivial design decision | ADL |

When you create `sdd/`, ask the user for the requirement format of SRS: EARS or structured. Write it in the "Requirement format" line of SRS. Use only that format in the project. To change the format, convert all requirements and change the line.

## Iteration loop (one increment)

### 1. Framing

- Update the core of PRD (goal, scope, success criteria).
- When the user describes a required behaviour, add or update an SRS requirement.
- If there are new quality drivers, add a QAS scenario.

### 2. Increment planning

- Split the goal into user stories as GitHub Issues with acceptance criteria.
- Link each user story to its SRS requirements.

### 3. Design (when a decision is important)

- Ask AI agent to propose a solution against the SRS, the drivers and the QAS.
- For an important choice, offer to create an ADR (options, decision, consequences, drivers).
- Add a line to ADL only for an accepted decision, after DESIGN shows it. A proposed decision has only an ADR with the status Proposed.
- Update DESIGN if the decision changes the picture.
- In DESIGN, update the C4 level that the change affects: context, containers or components.

### 4. Implementation with AI agent

- Work on one branch per user story.
- AI agent implements according to DESIGN and the acceptance criteria.
- AI agent updates SDD documents after confirmed decisions. For each propose decision choice, list which SDD documents would be changed.

### 5. Verification (automatic)

- GitHub Actions runs the tests. 
- The SRS requirements and the QAS scenarios are test cases.
- Add manual test instructions into deployment section of DESIGN, or instructions file if it exists.

### 6. Review and merge

- A pull request combines the code and the document updates.
- The review confirms conformance with SRS, DESIGN and the QAS.
- DESIGN shows the new state.
- PR comment summarizes changes in any SDD document as list.
