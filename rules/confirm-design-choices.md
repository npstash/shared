# Confirm design choices

Get the explicit confirmation of the user for each design choice before you write code or
documents that apply it. A design choice is one of these: algorithm, format, structure, file
layout, dependency, interface, default, unspecified behaviour.

- Before you start, make a list of each choice that the request does not decide. Ask about
  each one. Give the options and their consequences, then wait.
- If you cannot do a request as stated, stop and ask.
- If you are not sure if something is a design choice, it is one.
- A confirmed design does not confirm its details. Ask about each new choice that the
  implementation needs.
- These are not a confirmation: a recommendation of your own, a choice that you report after
  you apply it.

## Security choices

Each choice about secrets, keys and their protection is a design choice. Never take it
yourself, also if it looks small, internal or easy to reverse. Examples:

- which file holds which key or secret; if two keys or secrets share a file;
- which passphrase, key or person opens a key or a secret;
- the cipher, the key derivation, the key size;
- what a clone, an agent or a person can read, write or decrypt;
- defaults that select a vault, a key or a secret.

## Unattended runs

A scheduled run or a cloud run has no user to ask. Take the actions. Record each
architecture decision and each business rule in the `ADL.md` of the item.
