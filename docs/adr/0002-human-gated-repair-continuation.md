# Require human authorization for each repair continuation

AgentCI stops when a proposal reveals a different failure and reports an Unresolved Repair. A developer may authorize exactly one Continuation from the Check, accepting the rejected proposal as the next baseline; each additional failure requires another explicit action, preventing autonomous repair chains while preserving deliberate human-driven iteration.
