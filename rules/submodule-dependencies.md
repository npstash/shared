# Submodule dependencies

A shareable submodule is a repository that other repositories use as a submodule, e.g.
`shared` or a vault (`vault-<name>`). Its name is the name of its repository.

Find a shareable submodule only with the reference code below. Do not write a fixed path to
it in code, scripts or configuration.

## Lookup

1. Start in the folder of the project or the tool. Go up to the first folder with `.git` or
   `dependencies.txt`. This is the root.
2. If `.gitmodules` of the root has a submodule with the URL `.../<name>.git`, use its path.
   If that folder is empty, stop: the submodule has no checkout. Run `setup.sh`.
3. Else, use the first folder of the section `[<name>]` of `dependencies.txt` of the root that
   exists and is not empty.
4. Else, stop with an error. The error gives the folders that the lookup tried.

## dependencies.txt

- Put `dependencies.txt` into the root of the repository, if the repository uses a
  shareable submodule that is not its own submodule.
- Write one section for each submodule, and one path in each line, in the order of the search.
- Write each path relative to the folder of `dependencies.txt`. Absolute paths are not
  permitted.
- Lines that start with `#` are comments.

```
[shared]
../../shared
../shared
./shared
```

The three paths are for these layouts: the repository is a submodule in `projects/` of a
workspace; `shared` is a clone next to the repository; `shared` is a clone in the repository.

## Reference code

The reference code is [submodule-dependencies.py](submodule-dependencies.py).

- Copy the reference code into each project or tool that uses a shareable submodule, e.g.
  `src/dependencies.py`. Do not change the copy.
- Give `start`: the folder of the project or the tool. The default is the folder of the copy.
  It is not correct when the copy is installed as a package into a virtual environment.
- Scripts use the CLI: `python dependencies.py <name> [<start>]` writes the folder.
- Use only the standard library in the copy. A project can use it before it finds `shared`.
- To change the code, change the reference code, then copy the code again into each project and tool.
- Add a test that compares the copy with the reference code. Skip it if `shared` is not found.
  For an example, see the tests of [tools/auth](../tools/auth/tests/test_dependencies.py).
