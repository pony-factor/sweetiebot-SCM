# Optional Apple Neural Engine commit backend

Sweetiebot's default Ollama backend is unchanged. This native, opt-in bridge
lets the **commit-message generator** use the MIT-licensed
[CoreML-LLM](https://github.com/john-rocky/CoreML-LLM) Swift package instead.
Workspace Search embeddings and Ask Ollama remain on Ollama. Draft/manual
spellcheck uses Ollama model names and is not switched by this commit setting.

## Install (macOS 15+, Apple Silicon, Xcode/Swift 6)

The upstream library and its full Python model-conversion pipeline live in
CoreML-LLM, **not** in Sweetiebot. You can fork it into your own account and
clone the fork **beside** Sweetiebot to maintain or modify conversion scripts
separately. For example, if Sweetiebot lives at ~/GitHub/sweetiebot-SCM,
clone your fork into ~/GitHub/CoreML-LLM:

    git clone https://github.com/YOUR-ACCOUNT/CoreML-LLM.git ~/GitHub/CoreML-LLM
    SWEETIEBOT_COREML_LLM_FORK="$HOME/GitHub/CoreML-LLM" sh native/coreml-llm-bridge/install.sh

With no fork variable, the package resolves upstream release 1.9.0. No upstream
files, converted model weights, or large submodules are committed to Sweetiebot.
Review the model license separately. The bridge is an ordinary process running
on your Mac; no remote inference server or remote code invocation is needed.

Explicitly prepare a model once (the first invocation **downloads model
weights** if not already cached):

    "$HOME/Library/Application Support/Sweetiebot/ANE/sweetiebot-ane" --prepare qwen3.5-2b
    "$HOME/Library/Application Support/Sweetiebot/ANE/sweetiebot-ane" --prepare qwen3.5-0.8b

Then open Sweetiebot Settings → Ollama → Commit inference backend → coreml,
or configure globally:

    git config --global scm-toolkit.ai-backend coreml
    git config --global scm-toolkit.ai-coreml-model qwen3.5-2b
    git config --global scm-toolkit.ai-coreml-low-memory-model qwen3.5-0.8b

The configured bridge executable defaults to
~/Library/Application Support/Sweetiebot/ANE/sweetiebot-ane and can be changed
with scm-toolkit.ai-coreml-command. On failure, the existing strict/fallback
behavior applies. Change ai-backend to ollama to revert instantly.

The Swift service speaks newline-delimited JSON over private stdin/stdout and
keeps a model loaded across multiple calls in the same Git generation process.
It uses Core ML's cpuAndNeuralEngine compute units by default. Core ML decides
which operations actually execute on the ANE. These models are smaller than
Ollama's large GPU models and may generate worse commit messages; they are not
interchangeable GGUF model files. The bridge does **not** natively enforce JSON
Schema or sampling temperature; Sweetiebot requests JSON in the prompt and
continues to validate every title and emoji using its existing checks.

This optional integration has unit tests with a fake bridge, but native
compilation and on-device ANE residency must be verified on Apple Silicon.
