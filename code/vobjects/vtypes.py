from dataclasses import dataclass, field
import pprint
import vobject  # type: ignore[import-untyped]

from typing import List
from typing import Optional

@dataclass
class Name:
    prefix: str = ""
    given: str = ""
    additional: str = ""
    family: str = ""
    suffix: str = ""

    def from_vobject(self, name: vobject.vcard.Name) -> "Name":
        self.prefix = name.prefix
        self.given = name.given
        self.additional = name.additional
        self.family = name.family
        self.suffix = name.suffix
        return self

    def to_vobject(self) -> vobject.vcard.Name:
        name = vobject.vcard.Name()
        name.prefix = self.prefix
        name.given = self.given
        name.additional = self.additional
        name.family = self.family
        name.suffix = self.suffix
        return name

@dataclass
class Adr:
    type: str = ""
    box: str = ""
    city: str = ""
    code: str = ""
    country: str = ""
    extended: str = ""
    region: str = ""
    street: str = ""

    def from_vobject(self, type: str, adr: vobject.vcard.Address) -> "Adr":
        assert adr.lines == ('box', 'extended', 'street')
        assert adr.one_line == ('city', 'region', 'code')

        self.type = type
        self.box = adr.box
        self.city = adr.city
        self.code = adr.code
        self.country = adr.country
        self.extended = adr.extended
        self.region = adr.region
        self.street = adr.street
        return self

    def to_vobject(self) -> vobject.vcard.Address:
        adr = vobject.vcard.Address()
        adr.lines = ('box', 'extended', 'street')
        adr.one_line = ('city', 'region', 'code')

        adr.box = self.box
        adr.city = self.city
        adr.code = self.code
        adr.country = self.country
        adr.extended = self.extended
        adr.region = self.region
        adr.street = self.street
        return adr

@dataclass
class Tel:
    type: str
    number: str

@dataclass
class Email:
    type: str
    address: str

@dataclass
class Card:
    version: str = ""
    fn: str = ""
    n: Name = field(default_factory=Name)
    nickname: Optional[str] = None
    tel: List[Tel] = field(default_factory=list)
    email: List[Email] = field(default_factory=list)
    adr: List[Adr] = field(default_factory=list)
    rev: str = ""
    bday: Optional[str] = None
    gender: Optional[str] = None

    def from_vobject(self, card: vobject.vCard) -> "Card":
        self.version = card.version.value
        self.fn = card.fn.value
        self.n = Name().from_vobject(card.n.value)

        self.nickname = card.nickname.value if "nickname" in card.contents else None
        self.gender = card.gender.value if "gender" in card.contents else None

        if "tel" in card.contents:
            self.tel = [Tel(tel.type_param.upper(), tel.value) for tel in card.tel_list]
        else:
            self.tel = []

        if "email" in card.contents:
            self.email = [Email(email.type_param.upper(), email.value) for email in card.email_list]
        else:
            self.email = []

        if "adr" in card.contents:
            self.adr = [Adr().from_vobject(adr.type_param.upper(), adr.value) for adr in card.adr_list]
        else:
            self.adr = []

        if card.rev.params["VALUE"] != ["DATE-TIME"]:
            raise Exception(str(card.rev.params["VALUE"]))
        self.rev = card.rev.value

        if "bday" in card.contents:
            if card.bday.params["VALUE"] != ["DATE"]:
                raise Exception(str(card.bday.params["VALUE"]))
            self.bday = card.bday.value
        else:
            self.bday = None

        return self

    def to_vobject(self) -> vobject.vCard:
        card = vobject.vCard()
        card.add("version").value = self.version
        card.add("fn").value = self.fn
        if self.nickname:
            card.add("nickname").value = self.nickname
        if self.gender:
            card.add("gender").value = self.gender
        if self.bday:
            bday = card.add("bday")
            bday.params["VALUE"] = ["DATE"]
            bday.value = self.bday
        rev = card.add("rev")
        rev.params["VALUE"] = ["DATE-TIME"]
        rev.value = self.rev
        card.add("n").value = self.n.to_vobject()
        for tel in self.tel:
            vtel = card.add("tel")
            vtel.type_param = tel.type
            vtel.params["VALUE"] = ["UNKNOWN"]
            vtel.value = tel.number
        for email in self.email:
            vemail = card.add("email")
            vemail.type_param = email.type
            vemail.value = email.address
        for adr in self.adr:
            vadr = card.add("adr")
            vadr.type_param = adr.type
            vadr.value = adr.to_vobject()
        return card

def from_string(s: str) -> List[Card]:
    cards: List[Card] = eval(s)
    return cards

def to_string(cards: List[Card]) -> str:
    pp = pprint.PrettyPrinter(indent=2, width=900)
    return pp.pformat(cards)
