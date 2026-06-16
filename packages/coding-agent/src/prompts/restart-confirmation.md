Restart completed. This is the automated confirmation for your `restart` tool call ({{reason}}).

The omp process replaced itself in place and resumed this exact session from disk. You are now running:

- Version: {{version}}
- Artifact: {{artifact}}{{#if builtAt}} (built {{builtAt}}){{/if}}

The conversation above is the restored history; the rebuilt code is live in this process, including any tool or runtime changes it carries. Continue your task from where you left off and verify what you restarted for. Do not call `restart` again unless another rebuild needs adopting.
