# Phase 1 - Instagram Gateway and Conversations

**Goal:** Receive and send Instagram DMs reliably and store them per client, per project.

**Read in SPEC.md first (sections):** 31, 31A, 32, 33 (Client, Conversation, Message, Project, Agent Run, Event/Log), 36, 37, 39, 40, 41

Also follow 00_COMMON_RULES.md.

## Tasks
1. Webhook endpoint with signature verification.
2. Convert Instagram messages into normalized conversation events (channel-independent Conversation Engine).
3. Identify or create the client; create the project; store every message with timestamps.
4. Send DM replies through the API.
5. Idempotency: the same webhook delivered twice must not create duplicates (Section 41).
6. Track the time of the last client message per conversation (needed for the messaging-window warning in Section 31A).
7. Basic project record with initial state NEW/INTAKE, implemented as an explicit state machine (Sections 3-4).
8. Central logging and an agent-run log table (even though no AI agent exists yet).

## Deliverables / acceptance checks
- A test Instagram account can send a message and receive an automatic echo reply
- Two different test clients never see each other's conversation
- Duplicate webhook test passes
- Messages and projects are persisted

## Definition of done
Phase 1 is done when the acceptance checks above pass and the human can inspect stored conversations.

## NOT in this phase
Any AI requirements logic, specification, or coding agent.

## When finished
STOP and send the phase report described in 00_COMMON_RULES.md. Wait for human approval before the next phase.
