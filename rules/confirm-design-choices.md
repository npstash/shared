# Confirm design choices

Get the explicit confirmation of the user for each design choice before you write code or
documents that apply it. A design choice is one of these: algorithm, format, structure, file
layout, dependency, interface, default, unspecified behaviour.

If a request leaves a choice open, or you cannot do it as stated, stop. Give the options and their
consequences, then wait. A choice that you mention after you apply it is not confirmed. An entry
under "Actions taken" ([decision-gates](decision-gates.md)) is not a confirmation.

## Security choices

Treat each choice about secrets, keys and their protection as a design choice. Never take it
yourself, also if it looks small, internal or easy to reverse. Examples:

- which file holds which key or secret; if two keys or secrets share a file;
- which passphrase, key or person opens a key or a secret;
- the cipher, the key derivation, the key size;
- what a clone, an agent or a person can read, write or decrypt;
- defaults that select a vault, a key or a secret.

## Before you start

- Make a list of each choice that the request does not decide. Ask about each one before you
  write content that depends on it.
- If you are not sure if something is a design choice, it is one. Ask.
- A confirmed design does not confirm its details. Ask about each new choice that the
  implementation needs.
- Do not use a recommendation of your own as an answer. Wait for the answer of the user.

**Unattended runs** (scheduled or cloud, e.g. a Cowork cloud session): take the actions.
Record them as the rule [architecture-decision-log](architecture-decision-log.md) says.
