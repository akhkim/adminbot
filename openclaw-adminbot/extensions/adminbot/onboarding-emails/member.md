---
required_placeholders: first_name
group: member
applies_to: privilege_level = member
source: supplied verbatim by the lab ("Accept Full Member")
placeholders: { first_name }
note: |
  Links the site root rather than /signup, which is not a routed path. The landing page
  is where the root lands anyway, and Sign in -> Request an account is one click from
  there.
---

Subject: `Welcome to the Jinesis AI Research Lab – Onboarding Steps`

```text
Hi {first_name},

Thank you for your interest in joining the Jinesis AI Research Lab with Prof. Zhijing Jin! We're excited to have you on board.

To complete your onboarding as a full member, please follow these steps:

Step 1: Create your member portal account: Sign up at https://jinesis-admin.vercel.app and follow the onboarding guide in the portal.

Step 2: Create an email address for the Department of Computer Science (DCS) at the University of Toronto: Request your @cs.toronto.edu email through this form:

Highly preferred format:

- First choice: yourFirstName@cs.toronto.edu or yourLastName@cs.toronto.edu — e.g. david@cs.toronto.edu or smith@cs.toronto.edu
- Second choice: {first_letter_of_first_name}{full_last_name}@cs.toronto.edu — e.g. zjin@cs.toronto.edu

Otherwise you can pick one that you like. Our high preference is to make it very much reflect your first and last name, so we can use it for professional communications with senior external collaborators.

https://forms.office.com/r/TgGWBGWLZa

Step 3: Send an email to jinesis.adminbot@gmail.com with the email subject of "Create Jinesis slack access for XX@cs.toronto.edu email". Then in 1-2 days, you will receive an invitation to the full Slack workspace.

An internal mentee handbook should be shared with you already in your google drive folder, if you have any questions you can refer to there first.

If any of the steps does not proceed within 7 business days after you have done it, report the technical error to Andrew Kim at andrewkihyun@gmail.com.

Best regards,
Jinesis AI Research Lab
```

**Note:** `{first_letter_of_first_name}{full_last_name}` inside the body is the lab's
own example text, not a placeholder for the sender to fill. It must survive
substitution literally.
