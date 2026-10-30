/** Invalid tool arguments or input; the message is returned to the model. */
class ToolInputError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ToolInputError';
    }
}

/** Agent-level failure with a machine-readable code. */
class AgentError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'AgentError';
        this.code = code;
    }
}

module.exports = { ToolInputError, AgentError };
