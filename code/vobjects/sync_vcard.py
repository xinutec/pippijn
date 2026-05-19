from dataclasses import dataclass, field
import subprocess
import sys
import vobject  # type: ignore[import-untyped]
import vtypes


def main() -> None:

    for oldfile in sys.argv[1:]:
        if oldfile.endswith(".vcf"):
            pyfile = f"{oldfile[:-4]}.py"
            newfile = f"{oldfile[:-4]}-new.vcf"

            with open(oldfile, "r") as fh:
                objs = [vtypes.Card().from_vobject(card)
                        for card in vobject.readComponents(fh.read())]
            with open(pyfile, "w") as fh:
                fh.write(vtypes.to_string(objs))
        elif oldfile.endswith(".py"):
            pyfile = oldfile
            oldfile = f"{pyfile[:-3]}.vcf"
            newfile = f"{oldfile[:-4]}-new.vcf"

            with open(pyfile, "r") as fh:
                objs = vtypes.from_string(fh.read())

        with open(newfile, "w") as fh:
            fh.write("".join(obj.to_vobject().serialize() for obj in objs))

        subprocess.run(["diff", "-u", oldfile, newfile])

main()
