import { dedent } from "ts-dedent";
import { isWebGPUAvailable } from "./gpu";
import {
  updatePrompt,
  updateSearchResults,
  getDisableAiResponseSetting,
  getSummarizeLinksSetting,
  getUseLargerModelSetting,
  updateResponse,
  getSearchResults,
  updateUrlsDescriptions,
  getUrlsDescriptions,
} from "./pubSub";
import { SearchResults, search } from "./search";
import { sleep } from "./sleep";
import { query, debug, disableWorkers } from "./urlParams";
import toast from "react-hot-toast";

const Worker = disableWorkers ? undefined : window.Worker;

export async function prepareTextGeneration() {
  if (query === null) return;

  document.title = query;

  updatePrompt(query);

  updateLoadingToast("Searching the web...");

  const searchResults = await search(query, 30);

  updateSearchResults(searchResults);

  updateUrlsDescriptions(
    searchResults.reduce(
      (acc, [, snippet, url]) => ({ ...acc, [url]: snippet }),
      {},
    ),
  );

  updateLoadingToast("Ranking search results...");

  try {
    const rankedSearchResults = await rankSearchResultsWithTransformers(
      searchResults,
      query,
    );

    updateSearchResults(rankedSearchResults);
  } catch (error) {
    console.info(dedent`
      Could not rank search results due to error: ${error}

      Falling back to ranking with Levenshtein distance.
    `);

    const rankedSearchResults = await rankSearchResultsWithLevenshteinDistance(
      searchResults,
      query,
    );

    updateSearchResults(rankedSearchResults);
  }

  if (getDisableAiResponseSetting() && !getSummarizeLinksSetting()) return;

  if (debug) console.time("Response Generation Time");

  try {
    if (!isWebGPUAvailable) throw Error("WebGPU is not available.");

    await generateTextWithWebLlm();
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : (error as string);

    console.info(dedent`
      Could not load web-llm chat module: ${errorMessage}

      Falling back to transformers.js and wllama.
    `);

    if ("SharedArrayBuffer" in window) {
      try {
        await generateTextWithWllama();
      } catch (error) {
        console.error("Error while generating response with wllama:", error);
        await generateTextWithTransformersJs();
      }
    } else {
      try {
        await generateTextWithTransformersJs();
      } catch (error) {
        console.error(
          "Error while generating response with transformers.js:",
          error,
        );
        await generateTextWithWllama();
      }
    }
  }

  dismissLoadingToast();

  if (debug) {
    console.timeEnd("Response Generation Time");
  }
}

function updateLoadingToast(text: string) {
  toast.loading(text, {
    id: "text-generation-loading-toast",
    position: "bottom-center",
  });
}

function dismissLoadingToast() {
  toast.dismiss("text-generation-loading-toast");
}

async function generateTextWithWebLlm() {
  const { ChatWorkerClient, ChatModule, hasModelInCache } = await import(
    "@mlc-ai/web-llm"
  );

  type ChatOptions = import("@mlc-ai/web-llm").ChatOptions;

  const chat = Worker
    ? new ChatWorkerClient(
        new Worker(new URL("./webLlmWorker.ts", import.meta.url), {
          type: "module",
        }),
      )
    : new ChatModule();

  const availableModels = {
    Gemma: "gemma-2b-it-q4f32_1",
    TinyLlama: "TinyLlama-1.1B-Chat-v0.4-q4f32_1-1k",
  };

  const selectedModel = getUseLargerModelSetting()
    ? availableModels.Gemma
    : availableModels.TinyLlama;

  const commonChatMlConfig: ChatOptions = {
    temperature: 0,
    repetition_penalty: 1.1,
    max_gen_len: 512,
  };

  const chatConfigPerModel: { [x: string]: ChatOptions } = {
    [availableModels.Gemma]: {
      ...commonChatMlConfig,
    },
    [availableModels.TinyLlama]: {
      ...commonChatMlConfig,
      conv_template: "custom",
      conv_config: {
        system_template: "{system_message}",
        system_message: dedent`
          <|im_start|>system
          You are a highly knowledgeable and friendly assistant. Your goal is to understand and respond to user inquiries with clarity.<|im_end|>
          <|im_start|>user
          Hello!<|im_end|>
          <|im_start|>assistant
          Hi! How can I help you today?
        `,
        roles: {
          user: "<|im_start|>user",
          assistant: "<|im_start|>assistant",
        },
        offset: 0,
        seps: ["<|im_end|>\n"],
        role_content_sep: "\n",
        role_empty_sep: "\n",
        stop_str: ["<|im_end|>"],
        stop_token_ids: [2, 32002],
      },
    },
  };

  const appConfig = {
    model_list: [
      {
        local_id: availableModels.Gemma,
        model_url:
          "https://huggingface.co/mlc-ai/gemma-2b-it-q4f32_1-MLC/resolve/main/",
        model_lib_url:
          "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/gemma-2b-it/gemma-2b-it-q4f32_1-ctx4k_cs1k-webgpu.wasm",
      },
      {
        local_id: availableModels.TinyLlama,
        model_url:
          "https://huggingface.co/mlc-ai/TinyLlama-1.1B-Chat-v0.4-q0f32-MLC/resolve/main/",
        model_lib_url:
          "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/TinyLlama-1.1B-Chat-v0.4/TinyLlama-1.1B-Chat-v0.4-q0f32-ctx2k-webgpu.wasm",
      },
    ],
  };

  if (!(await hasModelInCache(selectedModel, appConfig))) {
    chat.setInitProgressCallback((report) =>
      updateLoadingToast(
        `Loading: ${report.text.replaceAll("[", "(").replaceAll("]", ")")}`,
      ),
    );
  }

  await chat.reload(
    selectedModel,
    chatConfigPerModel[selectedModel],
    appConfig,
  );

  if (!getDisableAiResponseSetting()) {
    updateLoadingToast("Generating response...");

    await chat.generate(
      dedent`
        I have a request/question for you, but before that, I want to provide you with some context.
        
        Context:
        ${getSearchResults()
          .slice(0, 5)
          .map(([title, snippet]) => `- ${title}: ${snippet}`)
          .join("\n")}

        Now, my request/question is:
        ${query}
      `,
      (_, message) => {
        if (message.length === 0) {
          chat.interruptGenerate();
        } else {
          updateResponse(message);
        }
      },
    );
  }

  await chat.resetChat();

  if (getSummarizeLinksSetting()) {
    updateLoadingToast("Summarizing links...");

    for (const [title, snippet, url] of getSearchResults()) {
      const request = dedent`
        When searching for "${query}", this link was found: [${title}](${url} "${snippet}")
        Now, tell me: What is this link about and how is it related to the search?
        Note: Don't cite the link in your response. Just write a few sentences to indicate if it's worth visiting.
      `;

      await chat.generate(request, (_, message) => {
        if (message.length === 0) {
          chat.interruptGenerate();
        } else {
          updateUrlsDescriptions({
            ...getUrlsDescriptions(),
            [url]: message,
          });
        }
      });

      await chat.resetChat();
    }
  }

  if (debug) {
    console.info(await chat.runtimeStatsText());
  }

  chat.unload();
}

async function generateTextWithWllama() {
  const { initializeWllama, runCompletion, exitWllama } = await import(
    "./wllama"
  );

  updateLoadingToast("Loading AI model...");

  const MobileDetect = (await import("mobile-detect")).default;

  const isRunningOnMobile =
    new MobileDetect(window.navigator.userAgent).mobile() !== null;

  const defaultModel =
    "https://huggingface.co/Felladrin/gguf-Llama-160M-Chat-v1/resolve/main/Llama-160M-Chat-v1.Q8_0.gguf";

  const largerModel = isRunningOnMobile
    ? defaultModel
    : "https://huggingface.co/Qwen/Qwen1.5-0.5B-Chat-GGUF/resolve/main/qwen1_5-0_5b-chat-q8_0.gguf";

  await initializeWllama({
    modelUrl: getUseLargerModelSetting() ? largerModel : defaultModel,
    modelConfig: {
      n_ctx: 2048,
    },
  });

  if (!getDisableAiResponseSetting()) {
    const prompt = dedent`
      <|im_start|>system
      You are a highly knowledgeable and friendly assistant. Your goal is to understand and respond to user inquiries with clarity.
      
      If the information below is useful, you can use it to complement your response. Otherwise, ignore it.

      ${getSearchResults()
        .slice(0, 5)
        .map(([title, snippet]) => `- ${title}: ${snippet}`)
        .join("\n")}<|im_end|>
      <|im_start|>user
      ${query}<|im_end|>
      <|im_start|>assistant
      
    `;

    if (!query) throw Error("Query is empty.");

    updateLoadingToast("Generating response...");

    const completion = await runCompletion({
      prompt,
      nPredict: 768,
      sampling: {
        temp: 0.25,
        top_k: 40,
        top_p: 0.95,
        min_p: 0.05,
        typical_p: 0.85,
        penalty_repeat: 1.1,
        mirostat: 2,
        mirostat_tau: 4.0,
      },
      onNewToken: (_token, _piece, currentText) => {
        updateResponse(currentText);
      },
    });

    updateResponse(completion.replaceAll("<|im_end|>", ""));
  }

  if (getSummarizeLinksSetting()) {
    updateLoadingToast("Summarizing links...");

    for (const [title, snippet, url] of getSearchResults()) {
      const prompt = dedent`
        <|im_start|>system
        You are a highly knowledgeable and friendly assistant. Your goal is to understand and respond to user inquiries with clarity.<|im_end|>
        <|im_start|>user
        Hello!<|im_end|>
        <|im_start|>assistant
        Hi! How can I help you today?<|im_end|>
        <|im_start|>user
        Context:
        ${title}: ${snippet}

        Question:
        What is this text about?<|im_end|>
        <|im_start|>assistant
        This text is about
      `;

      const completion = await runCompletion({
        prompt,
        nPredict: 128,
        sampling: {
          temp: 0.25,
          top_k: 40,
          top_p: 0.95,
          min_p: 0.05,
          typical_p: 0.85,
          penalty_repeat: 1.1,
          mirostat: 2,
          mirostat_tau: 4.0,
        },
        onNewToken: (_token, _piece, currentText) => {
          updateUrlsDescriptions({
            ...getUrlsDescriptions(),
            [url]: `This link is about ${currentText}`,
          });
        },
      });

      updateUrlsDescriptions({
        ...getUrlsDescriptions(),
        [url]: `This link is about ${completion.replaceAll("<|im_end|>", "")}`,
      });
    }
  }

  await exitWllama();
}

async function generateTextWithTransformersJs() {
  const { createWorker } = await import("../../node_modules/typed-worker/dist");

  const MobileDetect = (await import("mobile-detect")).default;

  const isRunningOnMobile =
    new MobileDetect(window.navigator.userAgent).mobile() !== null;

  const models = {
    mobileDefault: "Felladrin/onnx-Minueza-32M-UltraChat",
    mobileLarger: "Felladrin/onnx-Minueza-32M-UltraChat",
    desktopDefault: "Felladrin/onnx-TinyMistral-248M-Chat-v1",
    desktopLarger: "Xenova/Qwen1.5-0.5B-Chat",
  } as const;

  const defaultModel = isRunningOnMobile
    ? models.mobileDefault
    : models.desktopDefault;

  const largerModel = isRunningOnMobile
    ? models.mobileLarger
    : models.desktopLarger;

  const shouldUserLargerModel = getUseLargerModelSetting();

  const textGenerationModel = shouldUserLargerModel
    ? largerModel
    : defaultModel;

  const shouldUseQuantizedModels = !isRunningOnMobile || !shouldUserLargerModel;

  const updateResponseWithTypingEffect = async (text: string) => {
    let response = "";
    updateResponse(response);

    for (const character of text) {
      response = response + character;
      updateResponse(response);
      await sleep(5);
    }

    await sleep(text.length);
  };

  const filesProgress: Record<string, number> = {};

  let handleModelLoadingProgress:
    | ((e: { file: string; progress: number }) => void)
    | undefined = (e: { file: string; progress: number }) => {
    filesProgress[e.file] = e.progress ?? 100;
    const lowestProgress = Math.min(...Object.values(filesProgress));
    updateLoadingToast(`Loading: ${lowestProgress.toFixed(0)}%`);
  };

  type Actions = import("./transformersWorker").Actions;

  let transformersWorker: ReturnType<typeof createWorker<Actions>> | undefined;

  if (Worker) {
    transformersWorker = createWorker<Actions>(() => {
      const worker = new Worker(
        new URL("./transformersWorker", import.meta.url),
        {
          type: "module",
        },
      );

      worker.addEventListener("message", (event) => {
        if (
          handleModelLoadingProgress &&
          event.data.type === "model-loading-progress"
        ) {
          handleModelLoadingProgress(event.data.payload);
        }
      });

      return worker;
    });
  }

  let runTextToTextGenerationPipeline!: typeof import("./transformers").runTextToTextGenerationPipeline;

  let applyChatTemplate!: typeof import("./transformers").applyChatTemplate;

  if (!transformersWorker) {
    const transformersModule = await import("./transformers");
    runTextToTextGenerationPipeline =
      transformersModule.runTextToTextGenerationPipeline;
    applyChatTemplate = transformersModule.applyChatTemplate;
  }

  const generateResponse = async <T extends string | string[]>(
    input: T,
    pipelineArguments?: Record<string, unknown>,
  ): Promise<T> => {
    const paramsForResponse = {
      handleModelLoadingProgress: transformersWorker
        ? undefined
        : handleModelLoadingProgress,
      input,
      model: textGenerationModel,
      quantized: shouldUseQuantizedModels,
      pipelineArguments,
    };

    return transformersWorker
      ? (transformersWorker.run(
          "runTextToTextGenerationPipeline",
          paramsForResponse,
        ) as unknown as Promise<T>)
      : runTextToTextGenerationPipeline(paramsForResponse);
  };

  const formatChatMessages = async (
    chat: {
      role: string;
      content: string;
    }[],
  ) => {
    const parameters = {
      modelNameOrPath: textGenerationModel,
      chat,
      addGenerationPrompt: true,
    };
    return transformersWorker
      ? transformersWorker.run("applyChatTemplate", parameters)
      : applyChatTemplate(parameters);
  };

  await generateResponse("Hi!", { max_length: 1 });

  handleModelLoadingProgress = undefined;

  updateLoadingToast("Generating response...");

  if (!getDisableAiResponseSetting()) {
    const request = await formatChatMessages([
      {
        role: "system",
        content:
          "You are a friendly assistant who does your best to help the user. Start by providing an answer for the question below. If you don't know the answer, you can base your answer on the given context.",
      },
      {
        role: "user",
        content: dedent`
          Context:
          ${getSearchResults()
            .slice(0, 5)
            .map(([title, snippet]) => `- ${title}: ${snippet}`)
            .join("\n")}
          
          Question:
          ${query}
        `,
      },
    ]);

    const response = await generateResponse(request, {
      max_new_tokens: 256,
      repetition_penalty:
        textGenerationModel === models.mobileDefault
          ? 1.02
          : textGenerationModel === models.desktopDefault
            ? 1.01
            : 1.0,
      num_beams: 3,
      early_stopping: true,
    });

    const formattedResponse = response
      .substring(response.lastIndexOf("assistant\n"))
      .replace("assistant\n", "")
      .replace("<|im_end|>", "");

    await updateResponseWithTypingEffect(formattedResponse);
  }

  if (getSummarizeLinksSetting()) {
    updateLoadingToast("Summarizing links...");

    const updateUrlsDescriptionsWithTypingEffect = async (
      url: string,
      description: string,
    ) => {
      let newDescription = "";
      updateUrlsDescriptions({
        ...getUrlsDescriptions(),
        [url]: newDescription,
      });

      for (const character of description) {
        newDescription = newDescription + character;
        updateUrlsDescriptions({
          ...getUrlsDescriptions(),
          [url]: newDescription,
        });
        await sleep(5);
      }

      await sleep(description.length);
    };

    for (const [title, snippet, url] of getSearchResults()) {
      const formattedChat = await formatChatMessages([
        {
          role: "system",
          content:
            "You are a friendly assistant who does your best to help the user.",
        },
        {
          role: "user",
          content: `What is this text about?\n${title}: ${snippet}`,
        },
      ]);

      const request = `${formattedChat}This text is about`;

      const response = await generateResponse(
        request,
        textGenerationModel === models.mobileDefault
          ? {
              max_new_tokens: 128,
              repetition_penalty: 1.06,
              penalty_alpha: 0.5,
              top_k: 4,
            }
          : textGenerationModel === models.desktopDefault
            ? {
                max_new_tokens: 128,
                repetition_penalty: 1.035,
                penalty_alpha: 0.5,
                top_k: 4,
              }
            : {
                max_new_tokens: 128,
                repetition_penalty: 1.0,
                penalty_alpha: 0.5,
                top_k: 4,
              },
      );

      const formattedResponse = response
        .substring(response.lastIndexOf("assistant\n"))
        .replace("assistant\nThis text is about", "This link is about")
        .replace("<|im_end|>", "");

      await updateUrlsDescriptionsWithTypingEffect(url, formattedResponse);
    }

    if (transformersWorker) {
      transformersWorker.destroy();
    }
  }
}

async function rankSearchResultsWithTransformers(
  searchResults: SearchResults,
  query: string,
) {
  const { createWorker } = await import("../../node_modules/typed-worker/dist");

  type Actions = import("./transformersWorker").Actions;

  let transformersWorker: ReturnType<typeof createWorker<Actions>> | undefined;

  if (Worker) {
    transformersWorker = createWorker<Actions>(() => {
      const worker = new Worker(
        new URL("./transformersWorker", import.meta.url),
        {
          type: "module",
        },
      );

      return worker;
    });
  }

  let rank!: typeof import("./transformers").rank;

  if (!transformersWorker) {
    const transformersModule = await import("./transformers");
    rank = transformersModule.rank;
  }

  const snippets = searchResults.map(
    ([title, snippet]) => `${title}: ${snippet}`,
  );

  try {
    const rankedSearchResults: SearchResults = (
      await (transformersWorker
        ? transformersWorker.run("rank", query, snippets)
        : rank(query, snippets))
    ).map(({ corpus_id }) => searchResults[corpus_id]);

    transformersWorker?.destroy();

    return rankedSearchResults;
  } catch (error) {
    transformersWorker?.destroy();
    throw error;
  }
}

async function rankSearchResultsWithLevenshteinDistance(
  searchResults: SearchResults,
  query: string,
) {
  const { default: leven } = await import("leven");

  const urlToScoreMap: { [url: string]: number } = {};

  searchResults.forEach(([title, snippet, url]) => {
    const document = `${title}: ${snippet}`;
    const score = leven(query, document);
    urlToScoreMap[url] = score;
  });

  return searchResults.slice().sort(([, , url1], [, , url2]) => {
    return (urlToScoreMap[url2] ?? 0) - (urlToScoreMap[url1] ?? 0);
  });
}
