# Decision gates

Content that depends on an unconfirmed decision gets rewritten. Ask first.

## What needs a confirmation

Get the explicit confirmation of the user for each design choice before you write code or
documents that apply it. A design choice is one of these: algorithm, format, structure, file
layout, dependency, interface, default, unspecified behaviour.

- Before you start, make a list of each choice that the request does not decide. Ask about
  each one.
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

## How to ask

- Split the work into sections. Send one section with its questions in each reply.
- Give each question an id (`A1`, `B2`…), lettered options with consequences, and a
  recommendation.
- End the reply with the status of the section (closed or open) and the next step. Then wait.
- Deliver content that needs no decision without a stop.
- If the other decisions are few and cheap to reverse, do not ask: take the actions and
  continue. This does not apply to a design choice.
- At the top of each reply, under the heading "Actions taken", list each action that you took
  without input from the user: assumptions, questions that you answered. Write one line each,
  with no reasons and no options. Do not list the user decisions.

## Runs without a user

A scheduled run or a cloud run has no user to ask. Take the actions. Record each
architecture decision and each business rule in the `ADL.md` of the item.
