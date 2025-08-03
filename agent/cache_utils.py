import copy
from typing import List, Dict, Any

def add_cache_points(messages: List[Dict[str, Any]], is_claude: bool, is_nova: bool) -> List[Dict[str, Any]]:
    if not (is_claude or is_nova):
        return messages
    
    max_points = 2 if is_claude else 3 if is_nova else 0
    messages_with_cache = []
    user_turns_processed = 0
    
    for message in reversed(messages):
        m = copy.deepcopy(message)
        if m["role"] == "user" and user_turns_processed < max_points:
            append_cache = False
            if is_claude:
                append_cache = True
            elif is_nova:
                has_text = any(isinstance(c, dict) and "text" in c for c in m.get("content", []))
                if has_text:
                    append_cache = True
            if append_cache:
                if not isinstance(m["content"], list):
                    m["content"] = [{"text": m["content"]}]
                m["content"].append({"cachePoint": {"type": "default"}})
                user_turns_processed += 1
        messages_with_cache.append(m)
    
    messages_with_cache.reverse()
    return messages_with_cache 