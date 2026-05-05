vim.pack.add({
	{ src = "https://github.com/olimorris/codecompanion.nvim" },
	{ src = "https://github.com/dwood023/oh-my-pi.nvim" },
})

local log = require("codecompanion.utils.log")
local utils = require("codecompanion.utils.adapters")

require("codecompanion").setup({
	ignore_warnings = true,
	opts = {
		log_level = "TRACE",
	},
	strategies = {
		chat = {
			-- adapter = { name = "opencode", model = "big-pickle" },
			adapter = "or_qwen",
			opts = {
				completion_provider = "blink", -- blink|cmp|coc|default
			},
		},
		inline = {
			adapter = "or_qwen",
		},
		cmd = {
			adapter = "or_qwen",
		},
	},
	adapters = {
		http = {
			opts = {
				show_model_choices = false,
				show_defaults = false,
			},
			zen_grok = function()
				return require("codecompanion.adapters").extend("openai_compatible", {
					name = "Zen Grok",
					env = {
						url = "https://opencode.ai/zen/v1",
						api_key = "OPENCODE_ZEN_API_KEY",
						chat_url = "/chat/completions",
					},
					schema = {
						model = {
							default = "grok-code",
						},
					},
				})
			end,
			zen_qwen3 = function()
				return require("codecompanion.adapters").extend("openai_compatible", {
					name = "Zen Qwen3",
					env = {
						url = "https://opencode.ai/zen/v1",
						api_key = "OPENCODE_ZEN_API_KEY",
						chat_url = "/chat/completions",
					},
					schema = {
						model = {
							default = "qwen3-coder",
						},
					},
				})
			end,
			zen_pickle = function()
				return require("codecompanion.adapters").extend("openai_compatible", {
					name = "Zen Pickel",
					env = {
						api_key = "OPENCODE_ZEN_API_KEY",
						chat_url = "/chat/completions",
					},
					schema = {
						model = {
							default = "big-pickle",
						},
					},
				})
			end,
			zen_gpt51 = function()
				return require("codecompanion.adapters").extend("openai_responses", {
					name = "Zen GPT 5.1 Codex",
					url = "https://opencode.ai/zen/v1/responses",
					env = {
						api_key = "OPENCODE_ZEN_API_KEY",
					},
					schema = {
						model = {
							default = "gpt-5.1-codex",
						},
					},
				})
			end,
			or_qwen = function()
				return require("codecompanion.adapters").extend("openai_compatible", {
					name = "OpenRouter Qwen3",
					env = {
						url = "https://openrouter.ai/api",
						api_key = "OPENROUTER_API_KEY",
						chat_url = "/v1/chat/completions",
					},
					schema = {
						model = {
							default = "@preset/qwen3-coder",
						},
					},
				})
			end,
			or_gemini = function()
				return require("codecompanion.adapters").extend("openai_compatible", {
					name = "OpenRouter Gemini 2.5 Pro",
					env = {
						url = "https://openrouter.ai/api",
						api_key = "OPENROUTER_API_KEY",
						chat_url = "/v1/chat/completions",
					},
					schema = {
						model = {
							default = "@preset/gemini-2-5-pro",
						},
					},
				})
			end,
			or_gemini3 = function()
				return require("codecompanion.adapters").extend("openai_compatible", {
					name = "OpenRouter Gemini 3 Pro",
					env = {
						url = "https://openrouter.ai/api",
						api_key = "OPENROUTER_API_KEY",
						chat_url = "/v1/chat/completions",
					},
					schema = {
						model = {
							default = "@preset/gemini-3-pro",
						},
					},
				})
			end,
			or_gpt = function()
				return require("codecompanion.adapters").extend("openai_compatible", {
					name = "OpenRouter GPT 5.1 Codex",
					env = {
						url = "https://openrouter.ai/api",
						api_key = "OPENROUTER_API_KEY",
						chat_url = "/v1/chat/completions",
					},
					schema = {
						model = {
							default = "@preset/gpt-5-1-codex",
						},
					},
				})
			end,
		},
	},
})

vim.keymap.set({ "n", "v" }, "<leader>aa", "<cmd>CodeCompanionChat<cr>", { desc = "CodeCompanionChat" })

require("pi").setup()

vim.keymap.set("n", "<leader>ao", ":PiAsk<CR>", { desc = "Ask pi" })
vim.keymap.set("v", "<leader>ao", ":PiAskSelection<CR>", { desc = "Ask pi (selection)" })
