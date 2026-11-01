# Browser cookie consent

In browser automation, a page can show a cookie consent dialog. Click its "accept all" button.
Do not ask the user. Do not report the click as a decision.

- If the dialog has no "accept all" button, accept the cookies with the fewest clicks.
- If the dialog asks for more than cookie consent, e.g. an account or a payment, stop and ask
  the user.
