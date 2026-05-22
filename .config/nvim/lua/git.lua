vim.pack.add({
	{ src = "https://github.com/pwntester/octo.nvim" },
	{ src = "https://github.com/nvim-tree/nvim-web-devicons" },
	{ src = "https://github.com/lewis6991/gitsigns.nvim" },
	{ src = "https://github.com/sindrets/diffview.nvim" },
})

local wk = require("which-key")
wk.add({
	{ "<leader>g", group = "Git" },
})

wk.add({
	{ "<leader>gd", group = "Diff" },
})
vim.keymap.set("n", "<leader>gdf", "<cmd>DiffviewFileHistory %<cr>", { desc = "Diff File" })
vim.keymap.set("n", "<leader>gdh", "<cmd>DiffviewFileHistory<cr>", { desc = "Diff History" })
vim.keymap.set("n", "<leader>gp", "<cmd>DiffviewOpen<cr>", { desc = "Project Diff Current" })

local git_last_commit_signs = false

local function git_has_revision(revision, root)
	local command = root and { "git", "-C", root, "rev-parse", "--verify", revision }
		or { "git", "rev-parse", "--verify", revision }

	vim.fn.system(command)
	return vim.v.shell_error == 0
end

local function git_root()
	local cwd = vim.fn.expand("%:p:h")
	if cwd == "" then
		cwd = vim.fn.getcwd()
	end

	local root = vim.fn.systemlist({ "git", "-C", cwd, "rev-parse", "--show-toplevel" })[1]

	if vim.v.shell_error ~= 0 or not root or root == "" then
		vim.notify("Not inside a git repository", vim.log.levels.WARN)
		return nil
	end

	return root
end

local function git_status_for_file_browser(status)
	local status_kind = status:sub(1, 1)
	local status_map = {
		A = "A ",
		C = "C ",
		D = "D ",
		M = "M ",
		R = "R ",
		T = "M ",
	}

	return status_map[status_kind] or "M "
end

local function git_last_commit_files(root)
	local output = vim.fn.systemlist({
		"git",
		"-C",
		root,
		"diff",
		"--name-status",
		"--find-renames",
		"HEAD~1",
		"HEAD",
		"--",
	})

	if vim.v.shell_error ~= 0 then
		return nil, nil
	end

	local files = {}
	local statuses = {}

	for _, line in ipairs(output) do
		local parts = vim.split(line, "\t", { plain = true })
		local status = parts[1] or ""
		local status_kind = status:sub(1, 1)
		local path = (status_kind == "R" or status_kind == "C") and parts[3] or parts[2]

		if path and path ~= "" then
			local absolute_path = root .. "/" .. path
			table.insert(files, absolute_path)
			statuses[absolute_path] = git_status_for_file_browser(status)
		end
	end

	return files, statuses
end

local function open_git_last_commit_files()
	local root = git_root()
	if not root then
		return
	end

	if not git_has_revision("HEAD~1", root) then
		vim.notify("HEAD~1 does not exist", vim.log.levels.WARN)
		return
	end

	local files, statuses = git_last_commit_files(root)
	if not files then
		vim.notify("Unable to read files changed in HEAD", vim.log.levels.ERROR)
		return
	end

	if #files == 0 then
		vim.notify("No files changed in HEAD", vim.log.levels.INFO)
		return
	end

	local finders = require("telescope.finders")
	local previewers = require("telescope.previewers")
	local preview_utils = require("telescope.previewers.utils")

	local function browse_changed_files(opts)
		return finders.new_table({
			results = files,
			entry_maker = opts.entry_maker({
				cwd = root,
				git_file_status = statuses,
			}),
		})
	end

	local diff_previewer = previewers.new_buffer_previewer({
		title = "Diff",
		get_buffer_by_name = function(_, entry)
			return entry and entry.path and ("HEAD~1..HEAD:" .. entry.path) or nil
		end,
		define_preview = function(self, entry)
			if not entry or not entry.path then
				return
			end

			local relpath = entry.path:sub(#root + 2)
			local cmd =
				{ "git", "--no-pager", "diff", "--no-ext-diff", "--find-renames", "HEAD~1", "HEAD", "--", relpath }

			preview_utils.job_maker(cmd, self.state.bufnr, {
				cwd = root,
				value = relpath,
				bufname = self.state.bufname,
				callback = function(bufnr)
					if vim.api.nvim_buf_is_valid(bufnr) then
						preview_utils.highlighter(bufnr, "diff", {})
					end
				end,
			})
		end,
	})

	require("telescope").extensions.file_browser.file_browser({
		prompt_title = "Git Last Commit: HEAD vs HEAD~1",
		results_title = "Changed files",
		path = root,
		cwd = root,
		files = true,
		add_dirs = false,
		depth = false,
		display_stat = false,
		hide_parent_dir = true,
		git_status = true,
		git_icons = {
			added = "A",
			changed = "M",
			deleted = "D",
			renamed = "R",
			copied = "C",
		},
		browse_files = browse_changed_files,
		previewer = diff_previewer,
	})
end

require("gitsigns").setup({
	current_line_blame = true,
})

local function git_last_commit_signs_desc()
	return git_last_commit_signs and "[g]it signs: last [c]ommit shown" or "[g]it signs: [c]urrent changes shown"
end

local function toggle_git_last_commit_signs()
	local gitsigns = require("gitsigns")

	if git_last_commit_signs then
		gitsigns.reset_base(true)
		git_last_commit_signs = false
		vim.notify("Gitsigns: current changes view")
	else
		local root = git_root()
		if not root then
			return
		end

		if not git_has_revision("HEAD~1", root) then
			vim.notify("HEAD~1 does not exist", vim.log.levels.WARN)
			return
		end

		gitsigns.change_base("HEAD~1", true)
		git_last_commit_signs = true
		vim.notify("Gitsigns: last commit view (HEAD vs HEAD~1)")
	end

	vim.keymap.set("n", "<leader>gc", toggle_git_last_commit_signs, { desc = git_last_commit_signs_desc() })
end

vim.keymap.set("n", "<leader>gc", toggle_git_last_commit_signs, { desc = git_last_commit_signs_desc() })

vim.keymap.set("n", "<leader>C", open_git_last_commit_files, { desc = "Git last commit files" })

wk.add({
	{ "<leader>gh", group = "Hunk" },
})
vim.keymap.set("n", "<leader>ghd", "<cmd>Gitsigns preview_hunk<cr>", { desc = "Hunk diff" })
vim.keymap.set("n", "<leader>ghr", "<cmd>Gitsigns reset_hunk<cr>", { desc = "Hunk reset" })

require("octo").setup({})

wk.add({
	{ "<leader>ggp", group = "Github" },
})
vim.keymap.set("n", "<leader>ggp", "<cmd>Octo pr list<cr>", { desc = "Github PRs list" })
vim.keymap.set("n", "<leader>ggp", "<cmd>Octo pr list<cr>", { desc = "Github PRs list" })
vim.keymap.set("n", "<leader>ggr", "<cmd>Octo review<cr>", { desc = "Github PR review" })
