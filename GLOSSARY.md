# AgentCI

AgentCI is a repair agent that turns failed continuous-integration runs into verified repair proposals for human review.

## Language

**Repair Attempt**:
The bounded investigation of one Primary Failure, from its original evidence through a Validated Repair or a recorded inability to repair.
_Avoid_: Job, execution, agent run

**Primary Failure**:
The first actionable failure selected from the original CI evidence. It remains the sole target of a Repair Attempt even when a proposal reveals a different failure.
_Avoid_: Current error, latest failure, next problem

**Repair Proposal**:
A bounded set of source changes proposed by a Repair Attempt and presented for human review.
_Avoid_: Fix, solution, automatic repair

**Validated Repair**:
A Repair Proposal that passes the repository's declared verification command in an isolated environment.
_Avoid_: Successful fix, guaranteed repair

**Unresolved Repair**:
The terminal outcome of a Repair Attempt that could not produce a Validated Repair, accompanied by the observed failure and a summary of the rejected proposals.
_Avoid_: Failed fix, agent error

**Continuation**:
A developer's explicit authorization to accept the last rejected proposal as a new baseline and investigate exactly one newly revealed Primary Failure.
_Avoid_: Automatic continuation, repair loop

**Retry**:
A developer's explicit request to restart from the original revision and Primary Failure, discarding the proposals from the previous Repair Attempt.
_Avoid_: Continuation, resume

**Stale Repair**:
A Repair Attempt terminated because a newer eligible CI run superseded its repository revision.
_Avoid_: Cancelled repair, outdated fix

**Repository Contract**:
Repository-provided instructions and constraints that define how AgentCI may install dependencies and validate a Repair Proposal.
_Avoid_: Agent configuration, guessed commands

**Sandbox Runtime**:
An operator-approved, immutable container environment in which AgentCI prepares and validates Repair Proposals.
_Avoid_: Repository image, arbitrary container

**Repair PR**:
A draft pull request containing a Validated Repair for a human to review and decide whether to merge.
_Avoid_: Automatic PR, bot fix
