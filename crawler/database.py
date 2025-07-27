# database.py
import json
import logging
from typing import Dict, Any
from neo4j import AsyncGraphDatabase
from .models import Node, Interaction
from .constants import logger  # もしloggerが必要なら

async def init_database(driver):
    async with driver.session() as session:
        # Drop all constraints and indexes first
        try:
            await session.run("DROP CONSTRAINT node_state_hash IF EXISTS")
            await session.run("DROP CONSTRAINT node_url IF EXISTS") 
            await session.run("DROP INDEX node_state_hash IF EXISTS")
            await session.run("DROP INDEX node_url IF EXISTS")
            logger.info("Dropped existing constraints and indexes")
        except Exception as e:
            logger.info(f"No existing constraints/indexes to drop: {e}")
            
        # Delete all nodes and relationships completely
        await session.run("MATCH (n) DETACH DELETE n")
        logger.info("Database cleared - all nodes and relationships deleted")
        
        # Create indexes for Page only
        await session.run("CREATE INDEX node_state_hash IF NOT EXISTS FOR (n:Page) ON (n.state_hash)")
        await session.run("CREATE INDEX node_url IF NOT EXISTS FOR (n:Page) ON (n.page_url)")
        logger.info("Indexes created for Page")

async def save_node(driver, node: Node):
    async with driver.session() as session:
        await session.run(
            """
            MERGE (n:Page {state_hash: $state_hash})
            SET n.page_url = $page_url, n.html_snapshot = $html_snapshot,
                n.aria_snapshot = $aria_snapshot, n.dom_snapshot = $dom_snapshot,
                n.title = $title, n.heading = $heading, n.timestamp = $timestamp,
                n.visited_at = $visited_at
            """,
            **node.__dict__
        )

async def create_relation(driver, from_node: Node, to_node: Node, interaction: Interaction):
    rel_type = {
        'click': 'CLICK_TO',
        'input': 'INPUT_TO',
        'select': 'SELECT_TO',
        'navigate': 'NAVIGATE_TO',
        'submit': 'SUBMIT_TO'
    }.get(interaction.action_type, 'NAVIGATE_TO')
    
    props = {
        'element_id': interaction.selector,
        'action_type': interaction.action_type
    }
    if interaction.action_type == 'click':
        props['element_type'] = interaction.role or 'button'
    elif interaction.action_type == 'input':
        props['input_value'] = interaction.input_value
        props['required_value'] = 'test'  # Placeholder
    elif interaction.action_type == 'select':
        props['selected_value'] = interaction.selected_value or 'test'
    elif interaction.action_type == 'submit':
        props['form_id'] = interaction.form_id or 'unknown'
        props['action_url'] = to_node.page_url
    elif interaction.action_type == 'navigate':
        props['url'] = interaction.href
        props['navigation_type'] = 'link'
    # Add for others
    
    props['conditions'] = json.dumps({'auth_required': True})  # Example
    
    query = f"""
        MATCH (a:Page {{state_hash: $from_hash}})
        MATCH (b:Page {{state_hash: $to_hash}})
        MERGE (a)-[r:{rel_type} {{element_id: $element_id, action_type: $action_type}}]->(b)
        SET r += $props
    """
    async with driver.session() as session:
        await session.run(query, from_hash=from_node.state_hash, to_hash=to_node.state_hash, props=props, **props) 