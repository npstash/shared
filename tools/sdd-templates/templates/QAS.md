# Quality Attribute Scenarios

Quality attribute scenarios in the ADD (SEI) format. Each scenario is measurable and testable, so it becomes a test case directly. The format has six parts: source of stimulus, stimulus, environment, artifact, response, response measure.

## How to read a scenario

- **Source of stimulus:** who or what causes the event
- **Stimulus:** what occurs
- **Environment:** the conditions (normal load, failure, peak)
- **Artifact:** the container or component from DESIGN
- **Response:** what the system does
- **Response measure:** the measurable threshold of success

Write a value as an uppercase name. Give its default in "Default values", or refer to the document that defines it.

---

## QAS-001 — [name]

- **Quality attribute:**
- **Source of stimulus:**
- **Stimulus:**
- **Environment:**
- **Artifact:** [container or component]
- **Response:**
- **Response measure:**
- **Related ADR:** ADR-[yyyymmdd]-[topic]
- **Verification (test):**

### Example (filled in)

- **Quality attribute:** Performance
- **Source of stimulus:** End user
- **Stimulus:** Sends a read request
- **Environment:** Normal load, 1000 concurrent users
- **Artifact:** Read-layer API
- **Response:** The system returns a response
- **Response measure:** p95 < READ_LATENCY_MAX

---

## Scenario register

| ID | Attribute | Measure | ADR | Test |
| :-: | :-: | :-: | :-: | :-: |
| QAS-001 | | | ADR-[yyyymmdd]-[topic] | |

## Default values

| Name | Default | Unit | Configuration key | Meaning |
| --- | --- | --- | --- | --- |
| [NAME] | [value] | [unit] | [key] | [meaning] |
