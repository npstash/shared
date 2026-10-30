# Software Requirements Specification (SRS)

The required behaviour of the system. Write one requirement for each behaviour that the user asks for. Keep each requirement short.

**Requirement format:** [EARS | Structured]

## How to write a requirement

- Use only the requirement format of the project. Write one requirement as its format section says.
- [system] is the system, or one container of DESIGN if the requirement applies only to it.
- Group the requirements by feature. A feature can contain features. Use a maximum of two levels.
- Write a value as an uppercase name, e.g. RETRY_COUNT. Give its default in "Default values". In the text, add the default in parentheses, e.g. RETRY_COUNT (3).
- Do not change the ID of a requirement. Do not use the ID again.
- To remove a requirement, delete it. Git history keeps it.
- When you copy this template, keep the section of the selected format. Delete the other format section.

### Format: EARS

- Write one sentence in the EARS pattern. Use the pattern that fits:
  - **Always:** The [system] shall [response].
  - **Event:** When [trigger], the [system] shall [response].
  - **State:** While [state], the [system] shall [response].
  - **Unwanted:** If [condition], then the [system] shall [response].
  - **Option:** Where [feature], the [system] shall [response].
- Add Given / When / Then examples only if the sentence is not sufficient.

Example:

#### REQ-010 — Retry failed upload

When an upload fails, the system shall retry it RETRY_COUNT (3) times, then notify the user.

- Given: the network is down · When: the user uploads a file · Then: RETRY_COUNT (3) retries, then an error message

### Format: Structured

Write the fields in this order. Only **Basic Flow** is necessary. Omit a field that does not apply.

- **Pre-condition:** a state or an option that must be true.
- **Trigger:** the event that starts the behaviour. Without a trigger, the behaviour always applies.
- **Basic Flow:** one or more sentences "The [system] shall [response]." Use numbered steps when the order is important. Add a short explanation if necessary.
- **Alternative Flow:** [condition] → [response]. Write one item for each valid variant of the Basic Flow. An item can refer to a step, e.g. "Step 2: …".
- **Exception Flow:** [condition] → [response]. Write one item for each error or failure.
- **Post-condition:** the state after the behaviour. Write it only if a test needs it and the flows do not show it.

Example:

#### REQ-010 — Retry failed upload

- **Pre-condition:** The user is logged in.
- **Trigger:** An upload fails.
- **Basic Flow:** The system shall retry the upload a maximum of RETRY_COUNT (3) times.
- **Alternative Flow:** The upload succeeds at a retry → the system stops the retries.
- **Exception Flow:** All retries fail → the system shows an error message to the user.
- **Post-condition:** The file is on the server, or the user knows that the upload failed.

---

## 1. [feature A]

### 1.1 [feature A1]

#### REQ-001 — [short name]

[requirement in the format of the project]

#### REQ-002 — [short name]

[requirement in the format of the project]

## 2. [feature B]

#### REQ-003 — [short name]

[requirement in the format of the project]

---

## User interface

Describe each view of the user interface. A view is a screen, a window, a chat channel or a menu. Describe what the user sees and does, not the platform. Give the platform only in "Realization".

### UI-01 — [view name]

- **Purpose:** [what the user does in this view]
- **Shows:** [the information in the view]
- **Actions:** [user action → response of the system; REQ IDs]
- **Feedback:** [how the system confirms an action or reports an error]
- **Realization:** [the platform element, e.g. a screen of the app, a Discord channel]

---

## Default values

Define each value in the first SDD document that uses it. Other documents use the same name and refer to this table.

| Name | Default | Unit | Configuration key | Meaning |
| --- | --- | --- | --- | --- |
| [NAME] | [value] | [unit] | [key] | [meaning] |

Example:

| Name | Default | Unit | Configuration key | Meaning |
| --- | --- | --- | --- | --- |
| RETRY_COUNT | 3 | — | upload.retries | Retries of a failed upload |
