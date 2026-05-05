if exists('g:loaded_db_adapter_trino') | finish | endif
let g:loaded_db_adapter_trino = 1

" Optionally override CLI name/path:
 let g:trino_cli_command = '/usr/bin/trino'

function! db#adapter#trino#handles(url) abort
  return a:url =~? '^trino:'
endfunction

" Reuse Presto adapter’s URL parsing/canonicalization
function! db#adapter#trino#canonicalize(url) abort
  if exists('*db#adapter#presto#canonicalize')
    return db#adapter#presto#canonicalize(substitute(a:url, '^trino:', 'presto:', ''))
  endif
  " Fallback: no-op
  return a:url
endfunction

" Use Trino CLI instead of Presto CLI
function! db#adapter#trino#executable(conn) abort
  return get(g:, 'trino_cli_command', 'trino')
endfunction

" Delegate to Presto for arg construction, then swap the executable to 'trino'
function! db#adapter#trino#shell_command(conn) abort
  if !exists('*db#adapter#presto#shell_command')
    " Minimal fallback: build a basic Trino CLI command
    let l:host = get(a:conn, 'host', 'localhost')
    let l:port = get(a:conn, 'port', 8080)
    let l:user = get(a:conn, 'user', $USER)
    let l:catalog = get(a:conn, 'database', '')     " dadbod stores path db as 'database'
    let l:schema = get(a:conn, 'schema', '')
    let l:scheme = get(a:conn, 'protocol', 'http')

    let l:cmd = [db#adapter#trino#executable(a:conn),
          \ '--server', printf('%s://%s:%s', l:scheme, l:host, l:port),
          \ '--user', l:user,
          \ '--output-format', 'TSV',
          \ '--progress', 'false',
          \ '-f', '-' ]
    if !empty(l:catalog)
      call extend(l:cmd, ['--catalog', l:catalog])
    endif
    if !empty(l:schema)
      call extend(l:cmd, ['--schema', l:schema])
    endif
    return l:cmd
  endif

  let l:cmd = db#adapter#presto#shell_command(a:conn)
  let l:cmd[0] = db#adapter#trino#executable(a:conn)
  return l:cmd
endfunction
