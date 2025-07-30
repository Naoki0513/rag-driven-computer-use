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
        await session.run("CREATE INDEX node_url IF NOT EXISTS FOR (n:Page) ON (n.page_url)")
        logger.info("Indexes created for Page")

async def save_node(driver, node: Node):
    logger.info(f"Saving node for url: {node.page_url}")
    async with driver.session() as session:
        await session.run(
            """
            MERGE (n:Page {page_url: $page_url})
            SET n.html_snapshot = $html_snapshot,
                n.aria_snapshot = $aria_snapshot,
                n.title = $title, n.heading = $heading, n.timestamp = $timestamp
            """,
            **node.__dict__
        )

async def create_relation(driver, from_node: Node, to_node: Node, interaction: Interaction):
    rel_type = 'CLICK_TO'
    
    props = {
        'action_type': 'click',
        'element_type': interaction.role or 'button',
        'conditions': json.dumps({'auth_required': True})
    }
    
    query = f"""
        MATCH (a:Page {{page_url: $from_url}})
        MATCH (b:Page {{page_url: $to_url}})
        MERGE (a)-[r:{rel_type} {{action_type: $action_type, element_type: $element_type}}]->(b)
        SET r += $props
    """
    async with driver.session() as session:
        await session.run(query, from_url=from_node.page_url, to_url=to_node.page_url, props=props, **props) 