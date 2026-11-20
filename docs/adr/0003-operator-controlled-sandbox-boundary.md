# Keep the sandbox boundary under operator control

AgentCI runs as a host process on an officially supported Linux host and invokes Docker without exposing the Docker socket to an application container. Repository Contracts select only operator-approved runtime aliases pinned to image digests, preventing repositories from choosing arbitrary executor images while keeping local operation simple.
