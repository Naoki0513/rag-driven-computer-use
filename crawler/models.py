# models.py
from dataclasses import dataclass
from typing import Optional, List

@dataclass
class Node:
    page_url: str
    html_snapshot: str
    aria_snapshot: str
    title: str
    heading: str
    timestamp: str

@dataclass
class Interaction:
    selector: str
    text: str
    action_type: str  # click, input, select, navigate, submit
    href: Optional[str] = None
    role: Optional[str] = None
    name: Optional[str] = None
    ref_id: Optional[str] = None
    input_value: Optional[str] = None
    selected_value: Optional[str] = None
    form_id: Optional[str] = None

@dataclass
class QueueItem:
    node: Node
    depth: int 