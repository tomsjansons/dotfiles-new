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
	local output = vim.fn.system({
		"git",
		"-C",
		root,
		"diff",
		"--name-status",
		"-z",
		"--find-renames",
		"HEAD~1",
		"HEAD",
		"--",
	})

	if vim.v.shell_error ~= 0 then
		return nil, nil
	end

	local parts = vim.split(output, "\0", { plain = true, trimempty = true })
	local files = {}
	local statuses = {}
	local index = 1

	while index <= #parts do
		local status = parts[index]
		local status_kind = status:sub(1, 1)
		index = index + 1

		local path
		if status_kind == "R" or status_kind == "C" then
			index = index + 1
			path = parts[index]
			index = index + 1
		else
			path = parts[index]
			index = index + 1
		end

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

	local function browse_changed_files(opts)
		return finders.new_table({
			results = files,
			entry_maker = opts.entry_maker({
				cwd = root,
				git_file_status = statuses,
			}),
		})
	end

	local diff_previewer = previewers.new_termopen_previewer({
		title = "Diff",
		cwd = root,
		get_command = function(entry)
			if not entry or not entry.path then
				return nil
			end

			local relpath = entry.path:sub(#root + 2)
			return { "git", "diff", "--color=always", "--find-renames", "HEAD~1", "HEAD", "--", relpath }
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

vim.keymap.set("n", "<leader>gc", function()
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
end, { desc = "[g]it last [c]ommit view toggle" })

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
